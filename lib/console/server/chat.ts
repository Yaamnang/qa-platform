import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { redact } from "@/qa/explore/redact";
import type { AskKind, ChatMessage } from "../contract";
import { phrase } from "./phrase";
import { normalizeTotpSecret } from "./projects";
import type { JobPatch, JobRecord } from "./records";

/**
 * The live chat between a running job and the employee watching it.
 *
 * The runner opens a link for every job it starts. The link has a random
 * callback token, handed to the child process in CONSOLE_JOB_TOKEN; only its
 * SHA-256 hash is kept here. The child (qa/lib/console-link.ts) uses it to post
 * notes (say), ask questions (ask) and read steering messages (inbox) through
 * /api/console/jobs/:id/agent/*.
 *
 * SECRETS NEVER REACH THE MODEL OR THE TRANSCRIPT. An answer to a login or
 * code question lives only in this process's memory, in the pending ask, until
 * the child collects it, and is then dropped. The transcript (messages, which
 * is stored and shown) records only "Login provided" or "Code provided". The
 * values are added to the job's redaction list, so they are cut from the log
 * tail too, and Claude, when it phrases the run's lines (phrase.ts), only ever
 * sees the transcript.
 *
 * "Remember for this workspace" waits for proof. A remembered login or key is
 * held here, in memory, beside the pending answers, and saved only when the run
 * reports that sign-in worked (a say with the "signed-in" event, sent by
 * qa/explore/crawl.ts and qa/reporter/console-chat.ts). If the job ends first,
 * it is dropped, so a mistyped password is never stored.
 *
 * Steering messages are refused while the run waits for a login or a code, so
 * a password typed into the wrong box is not sent. Text that is sent is stored
 * as written, after redaction of the secrets already known: nothing here tries
 * to guess whether free text is a password.
 *
 * Every write for the job goes through the runner's own ordered write queue
 * (link.write), so a late chat update can never land on top of the final result.
 */

const MAX_MESSAGES = 300;
const MAX_TEXT = 2000;

export type AnswerValues =
  | { email: string; password: string }
  | { code: string }
  | { totpSecret: string }
  | { text: string }
  /** "Skip sign-in" on a login or code question: the run carries on without signing in. */
  | { skip: true };

type PendingAsk = { kind: AskKind; values: AnswerValues | null; closed: boolean };

/**
 * A login or setup key to save once sign-in has worked. save holds the
 * encrypted values in a closure (answer/route.ts); nothing here can read them.
 */
export type HeldRemember = {
  what: "Login" | "Authenticator key";
  save: () => Promise<void>;
};

/** The run's say event that proves sign-in worked. */
const SIGNED_IN_EVENT = "signed-in";
type JobLink = {
  tokenHash: Buffer;
  messages: ChatMessage[];
  asks: Map<string, PendingAsk>;
  /** Steering messages from the employee that the child has not read yet. */
  inbox: string[];
  /** Waiting for the run's sign-in to succeed. Memory only, one per kind, the latest wins. */
  held: Map<HeldRemember["what"], HeldRemember>;
  /** The runner's redaction list. Shared, so answers given later are cut from the log too. */
  secrets: string[];
  write: (patch: JobPatch) => Promise<void>;
  closed: boolean;
  waitingSince: number | null;
  waitedMs: number;
  /** Run lines are phrased one after another, so they keep their order. */
  chain: Promise<void>;
};

const g = globalThis as unknown as { __consoleJobLinks?: Map<string, JobLink> };
const links: Map<string, JobLink> = (g.__consoleJobLinks ??= new Map());

const hash = (token: string) => createHash("sha256").update(token).digest();

/** Called by the runner before it starts the child. Returns the raw token, which only the child gets. */
export function openLink(jobId: string, write: JobLink["write"], secrets: string[]): string {
  const token = randomBytes(32).toString("base64url");
  secrets.push(token);
  sortLongestFirst(secrets);
  links.set(jobId, {
    tokenHash: hash(token),
    messages: [],
    asks: new Map(),
    inbox: [],
    held: new Map(),
    secrets,
    write,
    closed: false,
    waitingSince: null,
    waitedMs: 0,
    chain: Promise.resolve(),
  });
  return token;
}

/**
 * Called by the runner when the child has finished. Open questions are marked
 * as expired, every held answer is dropped, and the final transcript is
 * returned for the runner's last write.
 */
export function closeLink(jobId: string): ChatMessage[] | undefined {
  const link = links.get(jobId);
  if (!link) return undefined;
  // Sign-in never reported success: drop the values. Added straight to the
  // final transcript, which the runner writes next.
  for (const item of link.held.values()) {
    link.messages.push({ id: `msg_${randomUUID().replace(/-/g, "").slice(0, 10)}`, at: Date.now(), from: "system", text: `${item.what} not saved: sign-in did not succeed.` });
  }
  link.held.clear();
  link.closed = true;
  link.asks.clear();
  link.inbox = [];
  for (const message of link.messages) {
    if (message.ask && !message.ask.answered) message.ask = { ...message.ask, expired: true };
  }
  links.delete(jobId);
  return link.messages;
}

/** How long the job has spent waiting for the employee. The runner's time limit does not count it. */
export function waitedMs(jobId: string): number {
  const link = links.get(jobId);
  if (!link) return 0;
  return link.waitedMs + (link.waitingSince === null ? 0 : Date.now() - link.waitingSince);
}

/**
 * The job with its chat as this process has it right now. Stored copies trail
 * by one write, so the routes answer with this instead, and a message the
 * employee just sent is in the reply.
 */
export function withLiveChat(job: JobRecord): JobRecord {
  const link = links.get(job.id);
  if (!link || link.closed) return job;
  const live: JobRecord = { ...job, messages: structuredClone(link.messages) };
  if (job.status === "running" || job.status === "waiting") live.status = link.waitingSince === null ? "running" : "waiting";
  return live;
}

/** True when the job is running here and can still chat. */
export function hasOpenLink(jobId: string): boolean {
  return links.get(jobId)?.closed === false;
}

/** Timing-safe check of "Authorization: Bearer <token>" against the job's token hash. */
export function tokenMatches(jobId: string, header: string | null): boolean {
  const link = links.get(jobId);
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!link || link.closed || !token) return false;
  return timingSafeEqual(hash(token), link.tokenHash);
}

// ---------------------------------------------------------------------------
// The run's side
// ---------------------------------------------------------------------------

export function runSay(jobId: string, text: string, event?: string): void {
  const link = links.get(jobId);
  if (!link || link.closed) return;
  const template = clean(text, link);
  if (template) {
    link.chain = link.chain.then(async () => {
      const wording = clean(await phrase("say", template, event, recentLines(link)), link);
      append(link, { from: "run", text: wording || template });
    });
  }
  if (event === SIGNED_IN_EVENT) saveHeld(link);
}

/** Creates the question at once, so the child can start polling, and shows it once it is phrased. */
export function runAsk(jobId: string, kind: AskKind, prompt: string, event?: string): string | null {
  const link = links.get(jobId);
  if (!link || link.closed) return null;
  const askId = `ask_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  link.asks.set(askId, { kind, values: null, closed: false });
  const template = clean(prompt, link) || defaultPrompt(kind);
  link.chain = link.chain.then(async () => {
    const wording = clean(await phrase("ask", template, event, recentLines(link)), link) || template;
    append(link, { from: "run", text: wording, ask: { id: askId, kind, prompt: wording, answered: false } });
  });
  return askId;
}

/**
 * The child collecting an answer. Once handed over, the answer is dropped
 * from memory: the console keeps no copy of it.
 */
export function pollAsk(jobId: string, askId: string): { state: "pending" } | { state: "closed" } | { state: "answered"; values: AnswerValues } {
  const ask = links.get(jobId)?.asks.get(askId);
  if (!ask || ask.closed) return { state: "closed" };
  if (!ask.values) return { state: "pending" };
  const values = ask.values;
  links.get(jobId)?.asks.delete(askId);
  return { state: "answered", values };
}

/** The child gave up waiting. */
export function cancelAsk(jobId: string, askId: string): void {
  const link = links.get(jobId);
  const ask = link?.asks.get(askId);
  if (!link || !ask) return;
  ask.closed = true;
  link.asks.delete(askId);
  link.chain = link.chain.then(() => {
    markAsk(link, askId, { expired: true });
    append(link, { from: "system", text: "No answer came in time, so the run stopped waiting." });
  });
}

export function drainInbox(jobId: string): string[] {
  const link = links.get(jobId);
  if (!link) return [];
  const out = link.inbox;
  link.inbox = [];
  return out;
}

// ---------------------------------------------------------------------------
// The employee's side
// ---------------------------------------------------------------------------

/**
 * Why a steering message cannot be sent right now, or null. While the run
 * waits for a login or a code, only the sign-in form may be answered.
 */
export function steeringRefusal(jobId: string): string | null {
  const link = links.get(jobId);
  if (!link || link.closed) return "This job is no longer running.";
  const signingIn = [...link.asks.values()].some((a) => (a.kind === "login" || a.kind === "code") && !a.closed && !a.values);
  return signingIn ? "The run is waiting for a sign-in. Answer the sign-in form first." : null;
}

/**
 * A steering message. Shown in the chat and passed to the run's next step.
 * Returns false when the job has ended or is waiting for a sign-in
 * (steeringRefusal says which).
 */
export function employeeMessage(jobId: string, text: string): boolean {
  const link = links.get(jobId);
  if (!link || link.closed || steeringRefusal(jobId)) return false;
  const safe = clean(text, link);
  if (!safe) return true;
  link.inbox.push(safe);
  append(link, { from: "employee", text: safe });
  return true;
}

/** The open question with this id, if the job is still waiting for it. */
export function openAsk(jobId: string, askId: string): { kind: AskKind } | null {
  const link = links.get(jobId);
  const ask = link?.asks.get(askId);
  if (!link || link.closed || !ask || ask.closed || ask.values) return null;
  const shown = link.messages.some((m) => m.ask?.id === askId && !m.ask.answered && !m.ask.expired);
  return shown ? { kind: ask.kind } : null;
}

/**
 * Checks an answer's shape for the kind of question. The values stay on the
 * server; nothing here logs them.
 */
export function parseAnswer(kind: AskKind, raw: unknown): { values: AnswerValues } | { error: string } {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : "");
  if ((kind === "login" || kind === "code") && v.skip === true) return { values: { skip: true } };
  if (kind === "login") {
    const email = str("email").trim();
    const password = str("password");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter the QA account's email address." };
    if (!password) return { error: "Enter the QA account's password." };
    return { values: { email, password } };
  }
  if (kind === "code") {
    if (str("totpSecret").trim()) {
      const secret = normalizeTotpSecret(str("totpSecret"));
      if (!secret) return { error: "That is not a valid setup key. Paste the base32 key the authenticator setup shows." };
      return { values: { totpSecret: secret } };
    }
    const code = str("code").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) return { error: "Enter the six-digit code." };
    return { values: { code } };
  }
  const text = str("text").trim();
  if (!text) return { error: "Enter an answer." };
  return { values: { text: text.slice(0, MAX_TEXT) } };
}

/** Hands the answer to the waiting run. The transcript only says that it was provided. */
export function answerAsk(jobId: string, askId: string, values: AnswerValues): boolean {
  const link = links.get(jobId);
  const ask = link?.asks.get(askId);
  if (!link || !ask || link.closed || ask.closed || ask.values) return false;

  // Cut from the log tail from now on, whatever the child prints.
  const hidden = "password" in values ? [values.password] : "code" in values ? [values.code] : "totpSecret" in values ? [values.totpSecret] : [];
  for (const value of hidden) if (value && !link.secrets.includes(value)) link.secrets.push(value);
  sortLongestFirst(link.secrets);

  ask.values = values;
  const summary =
    "email" in values ? "Login provided"
    : "code" in values ? "Code provided"
    : "totpSecret" in values ? "Authenticator key provided"
    : "skip" in values ? "Skipped sign-in"
    : clean(values.text, link);
  markAsk(link, askId, { answered: true });
  append(link, { from: "employee", text: summary });
  return true;
}

/**
 * Holds a login or key the employee asked to remember until the run reports
 * that sign-in worked. Returns false when the job has ended, and nothing is kept.
 */
export function holdRemember(jobId: string, item: HeldRemember): boolean {
  const link = links.get(jobId);
  if (!link || link.closed) return false;
  link.held.set(item.what, item);
  return true;
}

/** A line from the console itself, such as "Saved for this workspace." */
export function systemMessage(jobId: string, text: string): void {
  const link = links.get(jobId);
  if (link && !link.closed) append(link, { from: "system", text });
}

// ---------------------------------------------------------------------------

function append(link: JobLink, message: Omit<ChatMessage, "id" | "at">): void {
  if (link.closed) return;
  link.messages.push({ id: `msg_${randomUUID().replace(/-/g, "").slice(0, 10)}`, at: Date.now(), ...message });
  if (link.messages.length > MAX_MESSAGES) link.messages.splice(0, link.messages.length - MAX_MESSAGES);
  persist(link);
}

function markAsk(link: JobLink, askId: string, change: { answered?: boolean; expired?: boolean }): void {
  link.messages = link.messages.map((m) => (m.ask?.id === askId ? { ...m, ask: { ...m.ask, ...change } } : m));
  persist(link);
}

/** Stores the transcript and moves the job between running and waiting. */
function persist(link: JobLink): void {
  if (link.closed) return;
  const open = link.messages.some((m) => m.ask && !m.ask.answered && !m.ask.expired);
  // Two writes, so a database without the messages column still gets the status.
  void link.write({ messages: structuredClone(link.messages) });
  if (open && link.waitingSince === null) {
    link.waitingSince = Date.now();
    void link.write({ status: "waiting" });
  } else if (!open && link.waitingSince !== null) {
    link.waitedMs += Date.now() - link.waitingSince;
    link.waitingSince = null;
    void link.write({ status: "running" });
  }
}

/** Sign-in worked: saves what was held, in order after the run's own line. */
function saveHeld(link: JobLink): void {
  const items = [...link.held.values()];
  link.held.clear();
  for (const item of items) {
    link.chain = link.chain.then(async () => {
      try {
        await item.save();
        append(link, { from: "system", text: `${item.what} saved for this workspace.` });
      } catch {
        // The error could quote the stored row, so it is not shown.
        append(link, { from: "system", text: `${item.what} not saved: the workspace could not be updated.` });
      }
    });
  }
}

function recentLines(link: JobLink): string[] {
  return link.messages.slice(-4).map((m) => `${m.from}: ${m.text}`);
}

function clean(text: string, link: JobLink): string {
  return redact(String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT), link.secrets);
}

function defaultPrompt(kind: AskKind): string {
  if (kind === "login") return "The sign-in page is asking for the QA account's email and password.";
  if (kind === "code") return "The sign-in page is asking for a one-time code.";
  return "The run has a question.";
}

function sortLongestFirst(list: string[]): void {
  list.sort((a, b) => b.length - a.length);
}
