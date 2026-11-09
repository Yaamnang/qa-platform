/**
 * For manual exploration with `npm run dev`: prints the current one-time code
 * of a QA account, using the secrets in .env.local (never committed).
 *
 *   npm run otp                 code for the QA bot (Admin), from SEED_QA_TOTP_SECRET
 *   npm run otp -- --viewer     code for the QA viewer (read-only), from SEED_QA_VIEWER_TOTP_SECRET
 *   npm run otp -- --init       add both logins to .env.local (keeps what is already there)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { codeForStep, newTotpSecret } from "../qa/lib/totp";

const file = ".env.local";
const ACCOUNTS = [
  { prefix: "SEED_QA", email: "qa-bot@synthetic.eclypse.test", label: "QA bot (Admin)" },
  { prefix: "SEED_QA_VIEWER", email: "qa-viewer@synthetic.eclypse.test", label: "QA viewer (read-only)" },
];

if (process.argv.includes("--init")) {
  let env = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const a of ACCOUNTS) {
    if (new RegExp(`^${a.prefix}_TOTP_SECRET=`, "m").test(env)) {
      console.log(`.env.local already has a ${a.label} login; leaving it alone.`);
      continue;
    }
    // Appends, so the Supabase and Claude keys already in .env.local stay.
    const password = randomBytes(12).toString("base64url");
    const lines = [`${a.prefix}_EMAIL=${a.email}`, `${a.prefix}_PASSWORD=${password}`, `${a.prefix}_TOTP_SECRET=${newTotpSecret()}`];
    const separator = env && !env.endsWith("\n") ? "\n" : "";
    env = `${env}${separator}${lines.join("\n")}\n`;
    console.log(`Added a ${a.label} login to .env.local`);
    console.log(`  email:    ${a.email}`);
    console.log(`  password: ${password}`);
  }
  writeFileSync(file, env);
  console.log("Run 'npm run dev', then 'npm run otp' (or 'npm run otp -- --viewer') whenever you need a code.");
  process.exit(0);
}

const prefix = process.argv.includes("--viewer") ? "SEED_QA_VIEWER" : "SEED_QA";
const env = existsSync(file) ? readFileSync(file, "utf8") : "";
const secret = env.match(new RegExp(`^${prefix}_TOTP_SECRET=(.+)$`, "m"))?.[1]?.trim() ?? process.env[`${prefix}_TOTP_SECRET`];
if (!secret) {
  console.error(`No ${prefix}_TOTP_SECRET found. Run: npm run otp -- --init`);
  process.exit(1);
}
const step = Math.floor(Date.now() / 30000);
const secondsLeft = 30 - Math.floor((Date.now() / 1000) % 30);
console.log(`${codeForStep(secret, step)}  (valid for ~${secondsLeft}s)`);
