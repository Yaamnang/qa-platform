/**
 * Try the QA console (the web app under /console) with one command and no setup.
 *
 *   npm run demo                   build if needed, start, print how to sign in
 *   npm run demo -- --port 4000    use another port (default 3000, or the next free one)
 *
 * What it does:
 *  0. Refuses to start if STORE=supabase is set in the shell or in an env
 *     file. The demo never touches a real database.
 *  1. Starts the app on the in-memory store with an environment it builds
 *     itself: a throwaway console employee, a throwaway QA bot for the
 *     stand-in, mock AI, plain-http cookies, and QA runs allowed on localhost.
 *  2. Signs in to the console through its API, as the employee, and adds one
 *     project: this same server, with the QA bot's login. So the console opens
 *     with something to Explore and Run QA against.
 *  3. Prints the address, the email and password, a QR code for an
 *     authenticator app, and a live six-digit code for anyone without a phone.
 *
 * About the secrets it prints. The employee's password and TOTP secret are
 * shown in the terminal of the person who ran this command, on purpose: that
 * is the only way for them to sign in. They are throwaway values made fresh on
 * every start, held only in this process and the server's memory, and they die
 * with it. They are never written to a file and never sent anywhere except to
 * the local server. The QA bot's login is never printed at all: the console
 * holds it, encrypted, and the runner uses it.
 *
 * The process handling (Playwright check, build check, child server, health
 * wait) follows qa/run.ts, so `npm run demo` and `npm run qa` behave the same way.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { codeForStep, newTotpSecret } from "../qa/lib/totp";

const ROOT = process.cwd();
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const PW_CLI = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");
/** The server's own output. Holds no credentials: the server never logs them. Under qa-results/, which git ignores. */
const SERVER_LOG = path.join("qa-results", "console-demo-server.log");

const DEMO_EMAIL = "demo@eclypse.test";
const QA_BOT_EMAIL = "qa-bot@synthetic.eclypse.test";
const PROJECT_NAME = "Stand-in platform (this server)";
const DEFAULT_PORT = 3000;
/** Without --port, this many ports from 3000 up are tried, so a dev server already on 3000 is not a dead end. */
const PORTS_TO_TRY = 20;
const TOTP_PERIOD = 30;

const { values: args } = parseArgs({ options: { port: { type: "string" } } });

const log = (...lines: string[]) => process.stdout.write((lines.length ? lines : [""]).join("\n") + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Same as qa/run.ts
// ---------------------------------------------------------------------------

/** Explore and Run QA both drive Chromium, so it has to be there before the first job. */
function ensureBrowser() {
  const r = spawnSync(process.execPath, [PW_CLI, "install", "chromium"], { stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error("Could not install the Playwright Chromium browser.");
}

function newestMtime(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(0, ...readdirSync(p).map((f) => newestMtime(path.join(p, f))));
}

/** Builds only when a source file is newer than the last build. */
function ensureBuild() {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  const sources = ["app", "lib", "components", "next.config.ts", "package.json"].map((p) => newestMtime(path.join(ROOT, p)));
  if (existsSync(buildId) && statSync(buildId).mtimeMs > Math.max(...sources)) return;
  log("• Building the app (next build)…");
  const r = spawnSync(process.execPath, [NEXT_BIN, "build"], { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if (r.status !== 0) throw new Error("next build failed");
}

async function healthy(baseURL: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Never a real database
// ---------------------------------------------------------------------------

/**
 * The env files `next start` reads (.env.production.local, .env.local,
 * .env.production, .env), plus .env.development.local, where a developer is
 * just as likely to have switched Supabase on.
 */
const ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local", ".env.development.local"];

/** A value as dotenv reads it: quotes removed, or a trailing " # comment" dropped. */
function envValue(raw: string): string {
  const value = raw.trim();
  const quoted = value.match(/^(['"`])(.*?)\1/);
  return quoted ? quoted[2] : value.replace(/\s#.*$/, "").trim();
}

/**
 * Where STORE=supabase is set, if anywhere: the shell, or an env file the
 * server could load. "supabase" is the same test isSupabaseEnabled() makes.
 * Only the STORE line is looked at, and no value is ever printed.
 *
 * serverEnv() also sets STORE=memory for the server, which on its own keeps
 * an env file from switching it to Supabase. Refusing as well means nobody
 * who has Supabase switched on is left thinking the demo used it.
 */
function supabaseSwitchedOnIn(): string | null {
  if (process.env.STORE?.trim() === "supabase") return "your shell";
  for (const file of ENV_FILES) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?STORE\s*=(.*)$/);
      if (match && envValue(match[1]) === "supabase") return file;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** True when something already answers on localhost:port. That is what matters: the printed address must reach this server. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "localhost", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true); // something is there, just slow
    });
    socket.once("error", () => resolve(false)); // refused: nobody listens
  });
}

async function choosePort(): Promise<number> {
  if (args.port !== undefined) {
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, got "${args.port}".`);
    if (await portInUse(port)) throw new Error(`Port ${port} is already in use. Stop what is using it or pass another --port.`);
    return port;
  }
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORTS_TO_TRY; port++) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error(`Ports ${DEFAULT_PORT} to ${DEFAULT_PORT + PORTS_TO_TRY - 1} are all in use. Pass a free one with --port.`);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

type Account = { email: string; password: string; totpSecret: string };

/** Fresh on every start, like qa/run.ts's QA bot: nothing to leak, nothing to commit. */
const throwAway = (email: string): Account => ({ email, password: randomBytes(12).toString("base64url"), totpSecret: newTotpSecret() });

/**
 * The server's whole configuration, built here.
 *
 * `next start` also reads .env files, but it never overrides a variable that
 * is already set, not even one set to an empty string. So every value the
 * demo depends on is set here, some deliberately empty, and nothing in a
 * developer's .env.local can change what the demo does.
 */
function serverEnv(employee: Account, bot: Account): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    // The in-memory store, whatever an env file says (main() has also refused to start if one says supabase).
    STORE: "memory",
    // Empty on purpose: with the in-memory store, encryption.ts then makes a
    // key for this process only. A key in .env.local is not used.
    CONSOLE_SECRET_KEY: "",
    AI_MODE: "mock",
    BUGS: "",
    JOB_STAGE_MS: process.env.JOB_STAGE_MS ?? "5000", // the fake AI job takes ~20s, as in qa/run.ts
    INSECURE_COOKIES: "1", // plain http on localhost
    // The console employee. Seeding the TOTP secret marks the authenticator as
    // already set up, so sign-in goes straight to the code (store.ts seed()).
    SEED_CONSOLE_EMAIL: employee.email,
    SEED_CONSOLE_PASSWORD: employee.password,
    SEED_CONSOLE_TOTP_SECRET: employee.totpSecret,
    // The stand-in's QA bot, the account the console's project signs in with.
    SEED_QA_EMAIL: bot.email,
    SEED_QA_PASSWORD: bot.password,
    SEED_QA_TOTP_SECRET: bot.totpSecret,
    // No read-only Viewer. A console project holds one QA account, so the
    // runner's role tests are skipped and reported as not run. Empty, not
    // unset, so a Viewer login in .env.local is not seeded either.
    SEED_QA_VIEWER_EMAIL: "",
    SEED_QA_VIEWER_PASSWORD: "",
    SEED_QA_VIEWER_TOTP_SECRET: "",
  };
}

async function startServer(port: number, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const baseURL = `http://localhost:${port}`;
  mkdirSync(path.join(ROOT, "qa-results"), { recursive: true });
  const logFile = createWriteStream(path.join(ROOT, SERVER_LOG));
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  child.stdout!.pipe(logFile);
  child.stderr!.pipe(logFile);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server exited early (see ${SERVER_LOG})`);
    if (await healthy(baseURL)) return child;
    await sleep(300);
  }
  await stopServer(child);
  throw new Error("The server did not become healthy within 60s");
}

/**
 * Stops the server, and with it any console job still running.
 *
 * The server stops a running job itself when it exits normally (the exit hook
 * in lib/console/server/runner.ts takes the job's whole process tree, browser
 * included). So the server is asked to stop and given time to do that, and
 * only forced if it does not.
 *
 * Asking differs by platform. On Linux and macOS that is SIGTERM. Windows has
 * no such signal: kill() ends the process at once and its exit hook never
 * runs. But on Ctrl+C Windows has already told every process in this console
 * window, the server included, so there it is just given the time.
 */
async function stopServer(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  const stoppedWithin = (ms: number) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);

  if (process.platform !== "win32") child.kill("SIGTERM");
  if (await stoppedWithin(5000)) return;

  // Still running: force it, together with everything it started.
  if (process.platform === "win32" && child.pid !== undefined) {
    // /T takes the whole tree, /F does not wait. Full path, so PATH cannot swap the program (as in runner.ts).
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
  await stoppedWithin(5000);
}

// ---------------------------------------------------------------------------
// Setting up the console through its API, as a browser would
// ---------------------------------------------------------------------------

/** The console's cookies (challenge, then session), kept between requests the way a browser keeps them. */
const cookies = new Map<string, string>();

function rememberCookies(res: Response) {
  for (const header of res.headers.getSetCookie()) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // A deleted cookie comes back with an empty value.
    if (value) cookies.set(name, value);
    else cookies.delete(name);
  }
}

async function post<T>(baseURL: string, route: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${baseURL}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    },
    body: JSON.stringify(body),
  });
  rememberCookies(res);
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  // The console's error messages never contain a credential, so they are safe to print.
  if (!res.ok) throw new Error(`${route} answered ${res.status}: ${json?.error ?? "no reason given"}`);
  return json as T;
}

const stepNow = () => Math.floor(Date.now() / 1000 / TOTP_PERIOD);
const secondsLeft = () => TOTP_PERIOD - Math.floor((Date.now() / 1000) % TOTP_PERIOD);

/**
 * The code this script signs in with.
 *
 * A code works only once. If the script used the code that is current right
 * now, the person who ran it would type that same code a moment later and be
 * told it was already used. So it uses the previous 30-second window's code,
 * which the console still accepts to allow for clock drift (verifyTotp in
 * lib/server/totp.ts takes one window either side). The current code stays
 * unused, and so does every later one.
 *
 * It stays clear of the last two seconds of a window, as qa/lib/totp.ts does,
 * so the server is still in the same window when the request arrives.
 */
async function previousWindowCode(secret: string): Promise<string> {
  while (secondsLeft() <= 2) await sleep(250);
  return codeForStep(secret, stepNow() - 1);
}

/** Signs in as the demo employee, adds the project, signs out again. Only the person at the terminal ends up signed in. */
async function addDemoProject(baseURL: string, employee: Account, bot: Account) {
  const { next } = await post<{ next: string }>(baseURL, "/api/console/auth/login", {
    email: employee.email,
    password: employee.password,
  });
  if (next !== "verify") throw new Error(`Expected the demo employee to go straight to the code step, got "${next}".`);
  await post(baseURL, "/api/console/auth/verify", { code: await previousWindowCode(employee.totpSecret) });

  await post(baseURL, "/api/console/projects", {
    name: PROJECT_NAME,
    targetUrl: baseURL,
    qaEmail: bot.email,
    qaPassword: bot.password,
    qaTotpSecret: bot.totpSecret,
  });

  await post(baseURL, "/api/console/auth/logout");
}

// ---------------------------------------------------------------------------
// What the person at the terminal sees
// ---------------------------------------------------------------------------

/** The same otpauth address the console's own setup page puts in its QR code. */
function otpauthUri(employee: Account): string {
  const label = encodeURIComponent(`Eclypse Console:${employee.email}`);
  const issuer = encodeURIComponent("Eclypse Console");
  return `otpauth://totp/${label}?secret=${employee.totpSecret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

async function printSignIn(baseURL: string, employee: Account) {
  // small: two rows of the code per line of text, so it fits a normal
  // terminal. The library draws dark on light itself, so it scans on dark
  // and light themes alike.
  // Error correction L gives the smallest code; a screen does not get scuffed like a printed label.
  const qr = await QRCode.toString(otpauthUri(employee), { type: "terminal", small: true, errorCorrectionLevel: "L" });
  // Indented to line up with the text. Its last line holds only colour codes, so lines with nothing visible are dropped.
  const visible = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "").trim() !== "";
  const indent = (block: string) => block.split("\n").filter(visible).map((line) => `   ${line}`).join("\n");

  log(
    "",
    " QA console demo. Everything is in memory and is gone when you stop it.",
    "",
    ` Scan with any authenticator app, or add the setup key by hand: ${employee.totpSecret}`,
    "",
    indent(qr),
    "",
    " Open the QA console in your browser and sign in:",
    "",
    `   Address    ${baseURL}/login`,
    `   Email      ${employee.email}`,
    `   Password   ${employee.password}`,
    "   Code       from your authenticator app, or the live code below",
    "",
    ` The project "${PROJECT_NAME}" is ready. Open it, then Explore or Run QA.`,
    "",
    " Ctrl+C to stop.",
    "",
  );
}

/**
 * The current code, for anyone without a phone.
 *
 * In a terminal it is one line, rewritten in place every second: "\r" goes
 * back to the start of the line, so the scrollback gets nothing new. When the
 * output is not a terminal (piped to a file), "\r" means nothing, so a new
 * line is written only when the code changes.
 */
function startLiveCode(secret: string): () => void {
  let lastStep = -1;
  const tick = () => {
    const step = stepNow();
    const code = codeForStep(secret, step);
    const left = String(secondsLeft()).padStart(2, " ");
    if (process.stdout.isTTY) {
      process.stdout.write(`\r Live code  ${code}   changes in ${left}s `);
    } else if (step !== lastStep) {
      log(` Live code  ${code}   valid for ${left.trim()}s more`);
    }
    lastStep = step;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => {
    clearInterval(timer);
    if (process.stdout.isTTY) process.stdout.write("\n");
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // The demo makes throwaway accounts and must never put them, or its test
  // runs, into a real database.
  const switchedOn = supabaseSwitchedOnIn();
  if (switchedOn) {
    const fix = switchedOn === "your shell" ? "Unset it" : "Remove that line";
    log(`npm run demo uses the in-memory store only, but STORE=supabase is set in ${switchedOn}. ${fix} and run it again.`);
    process.exitCode = 1;
    return;
  }

  log("• Checking the Playwright browser…");
  ensureBrowser();
  ensureBuild();

  const port = await choosePort();
  const baseURL = `http://localhost:${port}`;
  const employee = throwAway(DEMO_EMAIL);
  const bot = throwAway(QA_BOT_EMAIL);

  log(`• Starting the QA console on ${baseURL}…`);
  const server = await startServer(port, serverEnv(employee, bot));
  let stopLiveCode = () => {};
  let stopping = false;

  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    stopLiveCode();
    log("• Stopping…");
    await stopServer(server);
    log("• Stopped.");
    process.exit(code);
  };
  // Ctrl+C, and a plain kill on Linux or macOS.
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  server.once("exit", (code, signal) => {
    if (stopping) return;
    stopLiveCode();
    log(`The server stopped by itself (${signal ?? `exit code ${code}`}). Its output is in ${SERVER_LOG}.`);
    process.exit(1);
  });

  try {
    log("• Signing in as the demo employee and adding a project…");
    await addDemoProject(baseURL, employee, bot);
    if (stopping) return; // Ctrl+C came while setting up
    await printSignIn(baseURL, employee);
    stopLiveCode = startLiveCode(employee.totpSecret);
    // Nothing more to do here. The server and the live code timer keep this
    // process running until Ctrl+C calls stop().
  } catch (err) {
    if (stopping) return;
    log(`Could not set up the QA console: ${(err as Error).message}`);
    await stop(1);
  }
}

main().catch((err: unknown) => {
  console.error(`npm run demo stopped with an error: ${(err as Error).message}`);
  process.exit(1);
});
