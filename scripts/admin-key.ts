/**
 * Sets up the /admin portal's sign-in in .env.local (never committed):
 *
 *   npm run admin-key -- --email you@eclypse.ai     first time
 *   npm run admin-key -- --new                      new phone, or the key leaked
 *
 * - ADMIN_EMAIL: from --email. Kept if already set.
 * - ADMIN_PASSWORD: kept if already set. Otherwise a new 32-character one,
 *   printed once here.
 * - ADMIN_TOTP_SECRET: a new key, shown as a QR code to scan with the
 *   authenticator app on your phone. Kept if already set, unless --new, which
 *   replaces it so the old phone entry stops working.
 *
 * In the terminal, not on a web page, because whoever can enrol a phone can
 * sign in as admin. Only someone with access to the server's files should.
 * See lib/admin/auth.ts for how the sign-in uses these.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { randomBase32Secret } from "../lib/server/totp";

const FILE = path.join(process.cwd(), ".env.local");

const { values } = parseArgs({ options: { email: { type: "string" }, new: { type: "boolean" } } });
let env = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";

const read = (key: string) => env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].trim() ?? "";

/** Replaces the line if it is there, appends it if not. Every other line stays. */
function write(key: string, value: string) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(env)) env = env.replace(pattern, line);
  else env = `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
}

async function main() {
  const email = values.email?.trim().toLowerCase() || read("ADMIN_EMAIL");
  if (!email) throw new Error("Pass --email the address you will sign in to /admin with.");
  write("ADMIN_EMAIL", email);

  let newPassword: string | null = null;
  if (read("ADMIN_PASSWORD").length < 16) {
    newPassword = randomBytes(24).toString("hex").slice(0, 32);
    write("ADMIN_PASSWORD", newPassword);
  }

  const existingKey = read("ADMIN_TOTP_SECRET");
  if (existingKey && !values.new) {
    writeFileSync(FILE, env);
    console.log("ADMIN_TOTP_SECRET is already set, so your phone stays as it is. Pass --new to replace it.");
    if (newPassword) console.log(`\nNew admin password (shown once):\n\n  ${newPassword}\n`);
    return;
  }

  const secret = randomBase32Secret();
  write("ADMIN_TOTP_SECRET", secret);
  writeFileSync(FILE, env);

  const label = encodeURIComponent(`Eclypse admin:${email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("Eclypse admin")}&algorithm=SHA1&digits=6&period=30`;
  console.log("Scan this with the authenticator app on your phone:\n");
  console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
  console.log(`Can't scan? Enter this key in the app instead: ${secret.match(/.{1,4}/g)!.join(" ")}\n`);
  if (newPassword) console.log(`Admin password (shown once, also in .env.local):\n\n  ${newPassword}\n`);
  if (existingKey) console.log("The old key is replaced. Delete the old \"Eclypse admin\" entry from your phone.");
  console.log(`Saved to .env.local. Sign in at /admin as ${email} with the password and the six-digit code from your phone.`);
  console.log("Clear this terminal once your phone shows the codes: the QR code is the key.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
