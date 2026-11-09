/**
 * Manage the QA console's employees from the terminal, on Supabase.
 *
 *   npm run admin -- setup  --email you@eclypse.ai --name "Your Name"
 *   npm run admin -- add    --email someone@eclypse.ai --name "Their Name"
 *   npm run admin -- list
 *   npm run admin -- remove --email someone@eclypse.ai [--yes]
 *
 * Why the terminal and not an admin page
 *
 * Whoever can run this already holds SUPABASE_SECRET_KEY, and that key is the
 * real admin power: it reads and writes every table directly. A login on this
 * command would guard nothing the key does not already open, so it has none.
 * A web admin page would be the opposite, a new way in: anyone holding a
 * stolen console session could add an employee or remove everyone else. With
 * no such page, a console session can run QA but never change who has access.
 *
 * It talks straight to Supabase, so it works while the site is live, from an
 * admin's laptop, with no access to the server.
 *
 * Supabase only. The in-memory store lives inside the running server's
 * process, which no other process can reach. There, `npm run demo` makes the
 * employee.
 *
 * Secrets
 *
 * The only secret this prints is a new employee's password, once, from add or
 * setup. Only its scrypt hash is stored. Nothing else secret is printed: no
 * key, no Supabase credential, no password hash or TOTP secret (list does not
 * even fetch those). setup may write a new CONSOLE_SECRET_KEY to .env.local
 * and does not print it.
 *
 * The npm script runs tsx with --conditions=react-server. The store modules
 * are marked "server-only", which refuses to load outside Next.js unless that
 * condition is set; it is how a server-side script says it is one.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, parseEnv } from "node:util";
import { loadEnvConfig } from "@next/env";
import { normalizeEmail } from "../lib/console/server/records";
import { supabaseConsoleBackend as store } from "../lib/console/server/store-supabase";
import { client } from "../lib/server/store-supabase";

const ROOT = process.cwd();
const KEY_VAR = "CONSOLE_SECRET_KEY";
/** Loose on purpose: it catches typos and stray spaces, nothing more. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMANDS = ["setup", "add", "list", "remove"];

const USAGE = [
  "Manage the QA console's employees on Supabase.",
  "",
  '  npm run admin -- setup  --email you@eclypse.ai --name "Your Name"',
  '  npm run admin -- add    --email someone@eclypse.ai --name "Their Name"',
  "  npm run admin -- list",
  "  npm run admin -- remove --email someone@eclypse.ai [--yes]",
].join("\n");

/** A refusal or a mistake the person can fix. Printed as plain text, with no stack trace. */
class AdminError extends Error {}

const log = (...lines: string[]) => console.log(lines.join("\n"));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads the env files `next start` reads, in its order (.env.production.local,
 * .env.local, .env.production, .env), with Next's own loader, which is what
 * the Next docs suggest for code that runs outside Next. A value set in the
 * shell wins over every file, as in Next. So this command and a server
 * started from the same folder always agree on which database is in use.
 *
 * Not tsx's --env-file flags, which db:seed uses: when several are given,
 * Node lets the later file win, so .env would override .env.local, the
 * opposite of Next.
 */
function loadEnv() {
  loadEnvConfig(ROOT, false, { info: () => {}, error: console.error });
}

/**
 * The same test as isSupabaseEnabled() in lib/server/auth-store.ts. It is
 * written out here because importing that module picks a backend as it
 * loads, and throws on a half-done setup before this command could explain.
 *
 * Returns the project's host, printed so the person sees which project they
 * are about to change. The address is not a secret; the key is.
 */
function supabaseHost(): string {
  if (process.env.STORE !== "supabase") {
    throw new AdminError(
      "Employees on the local in-memory store are created by npm run demo; set STORE=supabase to manage real employees.",
    );
  }
  const url = process.env.SUPABASE_URL;
  if (!url || !process.env.SUPABASE_SECRET_KEY) {
    throw new AdminError("STORE=supabase needs SUPABASE_URL and SUPABASE_SECRET_KEY to be set. Put them in .env.local.");
  }
  try {
    return new URL(url).host;
  } catch {
    throw new AdminError("SUPABASE_URL is not a valid address.");
  }
}

/** "Table not found", as PostgREST reports it (PGRST205), or as Postgres does (42P01) when passed through. */
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

/** Stops with the fix when a table is missing. Each check reads at most one id, never a secret. */
async function requireTables(tables: string[]) {
  for (const table of tables) {
    const { error } = await client().from(table).select("id").limit(1);
    if (!error) continue;
    if (MISSING_TABLE.has(error.code)) {
      throw new AdminError(
        "The tables are not there yet. Run db/schema.sql then db/schema-console.sql in the Supabase SQL editor first.",
      );
    }
    // A wrong key or address, or no network. Supabase's message names no credential.
    throw new AdminError(`Could not read ${table} on Supabase: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// CONSOLE_SECRET_KEY (encrypts each project's QA credentials, see encryption.ts)
// ---------------------------------------------------------------------------

/** Every .env file here, for whichever mode Next runs in. .env.example only ever holds blanks. */
function envFileNames(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\.env(\..+)?$/.test(entry.name) && entry.name !== ".env.example")
    .map((entry) => entry.name);
}

/**
 * Set in the shell or in any .env file, not only the files loaded above. That
 * is what makes "never overwrite" hold: a key that only .env.development.local
 * holds still counts, so a second, different key is never added beside it.
 * An empty "CONSOLE_SECRET_KEY=" line, as copied from .env.example, is not set.
 */
function secretKeyIsSet(): boolean {
  if (process.env[KEY_VAR]?.trim()) return true;
  return envFileNames().some((name) => parseEnv(readFileSync(path.join(ROOT, name), "utf8"))[KEY_VAR]?.trim());
}

/**
 * Appends a new key to .env.local, creating the file if needed (readable by
 * this user only, where the system supports it). Appending can never change a
 * value already in the file. An empty "CONSOLE_SECRET_KEY=" line above it is
 * harmless: when a name appears twice, the last line counts.
 */
function writeSecretKey() {
  const file = path.join(ROOT, ".env.local");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const newLineFirst = existing === "" || existing.endsWith("\n") ? "" : eol;
  const key = randomBytes(32).toString("base64");
  appendFileSync(
    file,
    `${newLineFirst}# Written by npm run admin -- setup. Back it up: without it, saved project credentials cannot be decrypted.${eol}` +
      `${KEY_VAR}=${key}${eol}`,
    { mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function readEmail(raw: string | undefined): string {
  const email = normalizeEmail(raw ?? "");
  if (!raw) throw new AdminError("--email is required, for example --email someone@eclypse.ai");
  if (!EMAIL.test(email)) throw new AdminError(`"${raw}" is not an email address.`);
  return email;
}

function readName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (name.length < 2 || name.length > 60) throw new AdminError('--name is required, 2 to 60 characters: --name "Their Name"');
  return name;
}

/**
 * Creates the employee with a random password and no authenticator yet
 * (newEmployee in records.ts sets totpConfirmed to false and hashes the
 * password). Their first sign-in walks them through the QR code.
 */
async function addEmployee(email: string, name: string) {
  if (await store.findEmployeeByEmail(email)) throw new AdminError(`${email} is already an employee.`);
  // 18 random bytes: a 24-character password, about 144 bits.
  const password = randomBytes(18).toString("base64url");
  await store.createEmployee({ email, displayName: name, password });
  // The one place this command prints a secret, on purpose and once.
  log(
    `Added ${name} <${email}>.`,
    "",
    `  Password: ${password}`,
    "",
    "This password will not be shown again. Hand it over directly, not by email or chat.",
    "On first sign-in the console asks them to scan a QR code with an authenticator app.",
  );
}

/** One-time bootstrap of a Supabase project. Every step checks before it acts, so running it again is safe. */
async function setup(email: string, name: string) {
  log("• Checking the tables");
  await requireTables(["eclypse_tenants", "console_employees"]);

  if (secretKeyIsSet()) {
    log(`• ${KEY_VAR} is already set, left as it is`);
  } else {
    writeSecretKey();
    log(`• Wrote a new ${KEY_VAR} to .env.local. Back it up: if it is lost, saved project credentials cannot be decrypted.`);
  }

  // scripts/seed-supabase.ts as it is, the script npm run db:seed runs, so the
  // seed data lives in one place. A child process because that script runs
  // and exits as soon as it loads. It gets the env loaded above. It wipes the
  // stand-in's eclypse_ rows first, as every QA run does; console_ tables are
  // never touched.
  log("• Seeding the stand-in tables (scripts/seed-supabase.ts)");
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const seed = spawnSync(process.execPath, [tsx, "--conditions=react-server", path.join("scripts", "seed-supabase.ts")], {
    stdio: "inherit",
    env: process.env,
  });
  if (seed.status !== 0) {
    throw new AdminError("Seeding the stand-in tables failed, see above. Setup is safe to run again once that is fixed.");
  }

  log("", "• First employee");
  if (await store.findEmployeeByEmail(email)) log(`${email} is already an employee, so nobody was added.`);
  else await addEmployee(email, name);
  log("", "Setup done.");
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

async function list() {
  const employees = await store.listEmployees();
  if (employees.length === 0) {
    log('No employees yet. Add one with npm run admin -- add --email someone@eclypse.ai --name "Their Name"');
    return;
  }
  const rows = [
    ["EMAIL", "NAME", "AUTHENTICATOR", "CREATED"],
    ...employees.map((e) => [e.email, e.displayName, e.totpConfirmed ? "set up" : "not yet", utc(e.createdAt)]),
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  for (const row of rows) log(row.map((cell, col) => cell.padEnd(widths[col])).join("   ").trimEnd());
  log("", `${employees.length} ${employees.length === 1 ? "employee" : "employees"}.`);
}

/** One line from the terminal. Input that closes with nothing typed is an empty answer, so it never confirms by accident. */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.once("close", () => resolve(""));
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

async function remove(email: string, confirmed: boolean) {
  const employee = await store.findEmployeeByEmail(email);
  if (!employee) throw new AdminError(`No employee has the email ${email}. npm run admin -- list shows who does.`);

  // Checked before asking, so nobody confirms only to be refused. Not atomic:
  // two admins removing the last two employees at the same moment could both
  // pass. Fine for a handful of admins; a database function would close it.
  if ((await store.listEmployees()).length <= 1) {
    throw new AdminError(`${email} is the only employee. Add another one first, or nobody could sign in.`);
  }

  if (!confirmed) {
    const typed = await ask(
      `This removes ${employee.displayName} <${employee.email}> and signs them out everywhere. Type their email again to confirm: `,
    );
    if (normalizeEmail(typed) !== employee.email) throw new AdminError("That did not match, so nothing was removed.");
  }

  const { sessionsEnded } = await store.deleteEmployee(employee.id);
  const sessions =
    sessionsEnded === 0
      ? "They had no open sessions."
      : `${sessionsEnded} ${sessionsEnded === 1 ? "session" : "sessions"} ended, so they are signed out now.`;
  log(`Removed ${employee.displayName} <${employee.email}>. ${sessions}`);
}

// ---------------------------------------------------------------------------

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        email: { type: "string" },
        name: { type: "string" },
        yes: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new AdminError(`${(err as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help) return log(USAGE);
  if (!command || !COMMANDS.includes(command)) {
    throw new AdminError(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
  }

  loadEnv();
  const host = supabaseHost();

  // Arguments are checked before anything touches the database.
  const email = command === "list" ? "" : readEmail(values.email);
  const name = command === "setup" || command === "add" ? readName(values.name) : "";

  log(`Supabase project ${host}`, "");
  if (command === "setup") return setup(email, name);
  await requireTables(["console_employees"]);
  if (command === "add") return addEmployee(email, name);
  if (command === "list") return list();
  return remove(email, values.yes === true);
}

main().catch((err: unknown) => {
  if (err instanceof AdminError) console.error(err.message);
  // Anything else comes from Supabase, Postgres or the network. Those messages
  // name tables and columns, never a credential.
  else console.error(`npm run admin stopped with an error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
