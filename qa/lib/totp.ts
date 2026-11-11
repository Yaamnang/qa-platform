import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config";
import { askCode, linked, noteSecret, rememberForRun } from "./console-link";

/**
 * One-time codes for the QA bot.
 *
 * The bot's account is enrolled with an authenticator (TOTP) secret held in the
 * CI secret store, so the bot computes its own codes exactly like a phone app
 * would. No email/SMS inbox, no test-only backdoor in the product.
 *
 * Platforms (rightly) refuse to accept the same code twice. Two sign-ins in
 * the same 30-second window would therefore fail at random, a classic source
 * of flaky tests. freshCode() remembers the last window it used for each
 * account and waits for the next one instead.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD = 30;

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("QA_TOTP_SECRET is not valid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

const stepNow = () => Math.floor(Date.now() / 1000 / PERIOD);
const stateFile = () => path.join(config.authDir, "totp-last-step.json");

/**
 * Each account (QA bot, QA viewer) is tracked on its own, so one account's
 * sign-in never makes the other wait. The key is a short fingerprint of the
 * secret, so the secret itself is never written to disk.
 */
const accountKey = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 12);

/** Last window used, per account: { "<fingerprint>": step }. */
function usedSteps(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")).steps ?? {};
  } catch {
    return {};
  }
}

/**
 * A code that has not been used yet. May wait up to ~30s for a new window.
 *
 * In a QA console run with no authenticator key, the run asks the employee in
 * the job's chat instead: they send a six-digit code (used once, as is), or
 * the setup key, which is kept for the rest of the run so later codes are made
 * here without asking again.
 */
export async function freshCode(secret = config.totpSecret): Promise<string> {
  if (!secret && linked()) {
    const answer = await askCode(
      `The sign-in page is asking for a one-time code for ${config.email || "the QA account"}. Send a new code, or the authenticator setup key so the run can make its own.`,
    );
    if ("code" in answer) return answer.code;
    rememberForRun({ totpSecret: answer.totpSecret });
    secret = answer.totpSecret;
  }
  if (!secret) throw new Error("QA_TOTP_SECRET is not set");
  const key = accountKey(secret);
  // Also avoid the last 2s of a window so the code can't expire mid-request.
  while (stepNow() <= (usedSteps()[key] ?? -1) || (Date.now() / 1000) % PERIOD > PERIOD - 2) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const step = stepNow();
  // Windows in the past can never block again, so drop them to keep the file small.
  const steps = Object.fromEntries(Object.entries(usedSteps()).filter(([, s]) => s >= step));
  steps[key] = step;
  mkdirSync(config.authDir, { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ steps }));
  const code = codeForStep(secret, step);
  // Redacted from the moment it exists. A code from the chat is noted by askCode.
  noteSecret(code);
  return code;
}

/**
 * Every code the secret made from sinceMs until a minute from now, at most
 * the last two hours. For redaction in a process that did not type the codes
 * itself, such as the reporter: it still cuts any code a worker typed.
 */
export function codesSince(secret: string, sinceMs: number): string[] {
  if (!secret) return [];
  const last = stepNow() + 2;
  const first = Math.max(Math.floor(sinceMs / 1000 / PERIOD) - 1, last - 240);
  try {
    const codes: string[] = [];
    for (let step = first; step <= last; step++) codes.push(codeForStep(secret, step));
    return codes;
  } catch {
    return []; // not valid base32, so it never made a code
  }
}

/** A 6-digit code that is guaranteed NOT to be accepted right now. */
export function wrongCode(secret = config.totpSecret): string {
  const s = stepNow();
  const valid = new Set([s - 1, s, s + 1, s + 2].map((x) => codeForStep(secret, x)));
  for (let i = 0; ; i++) {
    const candidate = String((123456 + i * 7919) % 1_000_000).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
}
