import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The run's side of the QA console's job chat.
 *
 * When the console starts a job it gives the child process two variables:
 * CONSOLE_JOB_URL (http://localhost:PORT/api/console/jobs/:id/agent) and
 * CONSOLE_JOB_TOKEN (random, for this job only). Everything in the child's
 * process tree inherits them: the explorer, qa/run.ts, Playwright and its
 * workers. With them, any of those can:
 *
 *   say(text)          post a short note to the chat
 *   ask({ kind, ... }) post a question and wait for the employee's answer
 *   inbox()            read steering messages the employee sent
 *
 * Without them (plain npm run qa, CI, npm run explore) say() does nothing and
 * ask() throws at once, so behaviour is exactly as before.
 *
 * Answers to login and code questions are secrets. They are never printed and
 * never posted back: the console records only "Login provided". Every value
 * received here is added to linkSecrets(), which qa/explore/redact.ts uses, so
 * it is cut from anything the run writes.
 */

const POLL_MS = 1000;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A note is not worth holding a run up for. */
const SAY_TIMEOUT_MS = 3000;

export type AskKind = "login" | "code" | "text";
export type LoginAnswer = { email: string; password: string };
export type CodeAnswer = { code: string } | { totpSecret: string };

const received: string[] = [];

/** True when this process was started by the console and can talk to the job's chat. */
export function linked(): boolean {
  return Boolean(process.env.CONSOLE_JOB_URL && process.env.CONSOLE_JOB_TOKEN);
}

export function askTimeoutMs(): number {
  const parsed = Number(process.env.CONSOLE_ASK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

/** Values received through ask() in this process, for redaction. */
export function linkSecrets(): string[] {
  return [...received];
}

function call(pathname: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  return fetch(`${process.env.CONSOLE_JOB_URL}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.CONSOLE_JOB_TOKEN}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * A note for the chat. event is a short tag ("signed-in", "verdict") the
 * console uses when it asks Claude to word the line. Never throws: a chat
 * that is down must not break a run.
 */
export async function say(text: string, event?: string): Promise<void> {
  if (!linked()) return;
  await call("/say", { method: "POST", body: JSON.stringify({ text, event }) }, SAY_TIMEOUT_MS).catch(() => undefined);
}

/**
 * Asks the employee and waits for the answer, polling once a second, for up
 * to CONSOLE_ASK_TIMEOUT_MS (default 10 minutes). Throws "No answer from the
 * console" when that runs out.
 */
export async function ask(question: { kind: AskKind; prompt: string; event?: string }): Promise<Record<string, unknown>> {
  if (!linked()) throw new Error("No console is connected to answer questions.");
  const created = await call("/ask", { method: "POST", body: JSON.stringify(question) }).catch(() => null);
  if (!created?.ok) throw new Error("Could not reach the console to ask a question.");
  const { askId } = (await created.json()) as { askId: string };

  const deadline = Date.now() + askTimeoutMs();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const res = await call(`/ask?id=${encodeURIComponent(askId)}`).catch(() => null);
    if (!res?.ok) continue; // a dropped request is retried on the next tick
    const body = (await res.json().catch(() => null)) as { state?: string; values?: Record<string, unknown> } | null;
    if (body?.state === "answered" && body.values) {
      if (question.kind !== "text") for (const value of Object.values(body.values)) {
        if (typeof value === "string" && value.length >= 4 && !value.includes("@")) received.push(value);
      }
      return body.values;
    }
    if (body?.state === "closed") break;
  }
  await call(`/ask?id=${encodeURIComponent(askId)}`, { method: "DELETE" }).catch(() => undefined);
  throw new Error("No answer from the console");
}

/**
 * The employee pressed "Skip sign-in" on a login or code question. The
 * explorer then carries on with public pages; anything else just stops, as
 * it would on any unexpected answer.
 */
export class SignInSkipped extends Error {
  constructor() {
    super("The employee chose to skip sign-in.");
  }
}

export async function askLogin(prompt: string): Promise<LoginAnswer> {
  const values = await ask({ kind: "login", prompt, event: "login-screen" });
  if (values.skip === true) throw new SignInSkipped();
  if (typeof values.email !== "string" || typeof values.password !== "string") throw new Error("The console sent an unexpected answer.");
  return { email: values.email, password: values.password };
}

export async function askCode(prompt: string): Promise<CodeAnswer> {
  const values = await ask({ kind: "code", prompt, event: "code-screen" });
  if (values.skip === true) throw new SignInSkipped();
  if (typeof values.totpSecret === "string") return { totpSecret: values.totpSecret };
  if (typeof values.code === "string") return { code: values.code };
  throw new Error("The console sent an unexpected answer.");
}

/** Steering messages the employee sent since the last call. Empty when not linked or on any error. */
export async function inbox(): Promise<string[]> {
  if (!linked()) return [];
  const res = await call("/inbox", {}, SAY_TIMEOUT_MS).catch(() => null);
  if (!res?.ok) return [];
  const body = (await res.json().catch(() => null)) as { messages?: unknown } | null;
  return Array.isArray(body?.messages) ? body.messages.filter((m): m is string => typeof m === "string") : [];
}

// ---------------------------------------------------------------------------
// Sharing an answer between the processes of one Probe run
//
// Playwright runs the sign-in (auth.setup.ts) in one worker and the other
// tests in later workers, which read the account from qa/lib/config.ts. An
// answer given to the first worker reaches the later ones through this file,
// encrypted (AES-256-GCM) with a key made from CONSOLE_JOB_TOKEN. That token
// lives only in this job's environment, so the file is unreadable to anything
// else and worthless once the job ends. global-teardown.ts deletes it.
// ---------------------------------------------------------------------------

type RunSecrets = { email?: string; password?: string; totpSecret?: string };

const runSecretsFile = () => path.join(process.cwd(), "qa", ".auth", "run-secrets.json");
const runKey = () => createHash("sha256").update(`eclypse-run-secrets\n${process.env.CONSOLE_JOB_TOKEN}`).digest();
let cache: RunSecrets | null = null;

function readRunSecrets(): RunSecrets {
  if (!linked()) return {};
  if (cache) return cache;
  try {
    const { iv, tag, data } = JSON.parse(readFileSync(runSecretsFile(), "utf8")) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", runKey(), Buffer.from(iv, "base64"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    cache = JSON.parse(plain) as RunSecrets;
    return cache;
  } catch {
    return {};
  }
}

export function runSecret(name: keyof RunSecrets): string | undefined {
  return readRunSecrets()[name] || undefined;
}

export function rememberForRun(values: RunSecrets): void {
  if (!linked()) return;
  const merged = { ...readRunSecrets(), ...values };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", runKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(merged), "utf8"), cipher.final()]);
  mkdirSync(path.dirname(runSecretsFile()), { recursive: true });
  writeFileSync(
    runSecretsFile(),
    JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }),
    { mode: 0o600 },
  );
  cache = merged;
}

export function forgetRunSecrets(): void {
  cache = null;
  rmSync(runSecretsFile(), { force: true });
}
