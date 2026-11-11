"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, Field } from "@/components/ui";
import { postJson } from "@/lib/client/api";
import type { ChatAsk, ChatMessage, Job } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../_components/api";
import { SecretField } from "../../../_components/SecretField";
import { isActive } from "../../../_components/status";

type Props = { job: Job; onChange: (job: Job) => void; className?: string };

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

/**
 * The job's chat: notes from the run, the employee's messages, and the run's
 * questions. An open question shows a form for exactly that answer instead of
 * the message box. Secret inputs are cleared the moment they are sent, and the
 * answer goes only to the run: the chat shows "Login provided", never the value.
 * While the run waits for a login or a code, the message box stays locked, so
 * a password cannot go into the stored chat by mistake.
 */
export function JobChat({ job, onChange, className = "" }: Props) {
  const active = isActive(job.status);
  const messages = job.messages ?? [];
  const open = active ? [...messages].reverse().find((m) => m.ask && !m.ask.answered && !m.ask.expired)?.ask : undefined;
  const signingIn = open?.kind === "login" || open?.kind === "code";
  const showBox = job.kind === "explore" && (!open || signingIn);

  return (
    <section aria-label="Chat" data-testid="job-chat"
      className={`flex flex-col overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm ${className}`}>
      <div className="flex items-center justify-between border-b border-ink-200 px-5 py-3">
        <span className="text-sm font-semibold text-ink-900">Chat</span>
        {active && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-500">
            <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-brand-500" />
            {open ? "Waiting for you" : "Live"}
          </span>
        )}
      </div>
      <MessageList messages={messages} />
      {/* A question always gets its form. The free message box is Explore only: Probe follows its saved plan and never reads messages. */}
      {active && (open || showBox) && (
        <div className="space-y-4 border-t border-ink-200 bg-ink-50 p-4">
          {open && <AskForm key={open.id} ask={open} job={job} onChange={onChange} />}
          {showBox && <MessageBox job={job} onChange={onChange} locked={signingIn} />}
        </div>
      )}
    </section>
  );
}

/** Newest at the bottom. Follows new messages unless the reader has scrolled up. */
function MessageList({ messages }: { messages: ChatMessage[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <ol ref={ref} data-testid="job-chat-messages" aria-live="polite" tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
      className="min-h-48 max-h-[28rem] flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm lg:max-h-none lg:min-h-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500">
      {messages.length === 0 && <li data-testid="job-chat-empty" className="text-ink-500">No messages yet.</li>}
      {messages.map((m) => <Message key={m.id} message={m} />)}
    </ol>
  );
}

function Message({ message: m }: { message: ChatMessage }) {
  const time = <time dateTime={new Date(m.at).toISOString()} className="font-mono text-[11px] text-ink-400">{TIME.format(m.at)}</time>;
  if (m.from === "system") {
    return (
      <li data-testid="job-chat-message" data-from="system" className="text-center text-xs text-ink-500">
        {m.text} {time}
      </li>
    );
  }
  const mine = m.from === "employee";
  return (
    <li data-testid="job-chat-message" data-from={m.from} className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
      <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 ${
        mine ? "bg-brand-100 text-ink-900" : "bg-ink-100 text-ink-800"
      }`}>
        {m.text}
        {m.ask && (
          <span data-testid="job-chat-ask-state" className="mt-1 block text-xs text-ink-500">
            {m.ask.answered ? "Answered" : m.ask.expired ? "No longer waiting" : "Waiting for your answer"}
          </span>
        )}
      </div>
      <span className="flex items-center gap-2 text-xs text-ink-500">{mine ? "You" : "Run"} {time}</span>
    </li>
  );
}

/** Sends to the API and hands back the updated job. The error is shown under the form. */
function useSend(job: Job, onChange: (job: Job) => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(path: "answer" | "messages", body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ job: Job }>(`/api/console/jobs/${job.id}/${path}`, body);
      onChange(r.job);
      return true;
    } catch (err) {
      if (isSignedOut(err)) router.replace("/login");
      else setError(errorMessage(err, "Could not reach the console. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { send, busy, error };
}

function FormError({ text, testId }: { text: string | null; testId: string }) {
  if (!text) return null;
  return <p role="alert" data-testid={testId} className="text-xs font-medium text-red-600">{text}</p>;
}

function Remember({ checked, onChange, testId }: { checked: boolean; onChange: (value: boolean) => void; testId: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId}
        className="size-4 rounded border-ink-300 accent-brand-500" />
      Remember for this workspace
    </label>
  );
}

/** Sends "skip" for a login or code question: the run carries on with public pages only. */
function SkipSignIn({ ask, send, busy, testId }: { ask: ChatAsk; send: (path: "answer", body: unknown) => Promise<boolean>; busy: boolean; testId: string }) {
  return (
    <button type="button" disabled={busy} onClick={() => void send("answer", { askId: ask.id, values: { skip: true } })} data-testid={testId}
      className="text-sm font-medium text-ink-500 underline-offset-4 hover:text-ink-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
      Skip sign-in
    </button>
  );
}

function AskForm({ ask, job, onChange }: { ask: ChatAsk; job: Job; onChange: (job: Job) => void }) {
  if (ask.kind === "login") return <LoginForm ask={ask} job={job} onChange={onChange} />;
  if (ask.kind === "code") return <CodeForm ask={ask} job={job} onChange={onChange} />;
  return <TextForm ask={ask} job={job} onChange={onChange} />;
}

function LoginForm({ ask, job, onChange }: { ask: ChatAsk; job: Job; onChange: (job: Job) => void }) {
  const id = useId();
  const { send, busy, error } = useSend(job, onChange);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const values = { email: email.trim(), password };
    setPassword(""); // cleared as soon as it is sent
    await send("answer", { askId: ask.id, values, remember });
  }

  return (
    <form onSubmit={submit} noValidate autoComplete="off" data-testid="job-chat-login-form" className="space-y-3">
      <Field id={`${id}-email`} label="QA account email" type="email" className="font-mono" value={email}
        onChange={(e) => setEmail(e.target.value)} data-testid="job-chat-login-email" />
      <SecretField id={`${id}-password`} label="QA account password" autoComplete="new-password" value={password}
        onChange={(e) => setPassword(e.target.value)} testId="job-chat-login-password" />
      <Remember checked={remember} onChange={setRemember} testId="job-chat-login-remember" />
      <FormError text={error} testId="job-chat-login-error" />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy} loadingText="Sending…" disabled={!email.trim() || !password} data-testid="job-chat-login-submit">
          Send login
        </Button>
        <SkipSignIn ask={ask} send={send} busy={busy} testId="job-chat-login-skip" />
      </div>
    </form>
  );
}

function CodeForm({ ask, job, onChange }: { ask: ChatAsk; job: Job; onChange: (job: Job) => void }) {
  const id = useId();
  const { send, busy, error } = useSend(job, onChange);
  const [useKey, setUseKey] = useState(false);
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const values = useKey ? { totpSecret: secret.replace(/\s+/g, "") } : { code };
    setCode(""); // cleared as soon as they are sent
    setSecret("");
    await send("answer", { askId: ask.id, values, remember: useKey && remember });
  }

  return (
    <form onSubmit={submit} noValidate autoComplete="off" data-testid="job-chat-code-form" className="space-y-3">
      {useKey ? (
        <>
          <SecretField id={`${id}-secret`} label="Authenticator setup key" autoComplete="off" className="font-mono" value={secret}
            hint="The base32 key from the authenticator setup. The run makes its own codes with it."
            onChange={(e) => setSecret(e.target.value)} testId="job-chat-code-secret" />
          <Remember checked={remember} onChange={setRemember} testId="job-chat-code-remember" />
        </>
      ) : (
        <Field id={`${id}-code`} label="One-time code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          className="font-mono tracking-[0.3em]" value={code}
          hint="Send it now. Codes change every 30 seconds."
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} data-testid="job-chat-code-input" />
      )}
      <FormError text={error} testId="job-chat-code-error" />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy} loadingText="Sending…" disabled={useKey ? !secret.trim() : code.length !== 6}
          data-testid="job-chat-code-submit">
          {useKey ? "Send key" : "Send code"}
        </Button>
        <button type="button" onClick={() => { setUseKey(!useKey); setCode(""); setSecret(""); }} data-testid="job-chat-code-switch"
          className="text-sm font-medium text-brand-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
          {useKey ? "Send a six-digit code instead" : "Give the authenticator setup key instead"}
        </button>
        <SkipSignIn ask={ask} send={send} busy={busy} testId="job-chat-code-skip" />
      </div>
    </form>
  );
}

function TextForm({ ask, job, onChange }: { ask: ChatAsk; job: Job; onChange: (job: Job) => void }) {
  const id = useId();
  const { send, busy, error } = useSend(job, onChange);
  const [text, setText] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await send("answer", { askId: ask.id, values: { text } })) setText("");
  }

  return (
    <form onSubmit={submit} noValidate data-testid="job-chat-text-form" className="space-y-3">
      <Field id={`${id}-text`} label="Your answer" value={text} onChange={(e) => setText(e.target.value)} data-testid="job-chat-text-input" />
      <FormError text={error} testId="job-chat-text-error" />
      <Button type="submit" loading={busy} loadingText="Sending…" disabled={!text.trim()} data-testid="job-chat-text-submit">Send</Button>
    </form>
  );
}

/**
 * Free text while the job runs, for example "look at the settings page". The
 * explorer reads it before its next step. Stored as written, so locked while
 * the run waits for a sign-in (the server refuses it then too).
 */
function MessageBox({ job, onChange, locked }: { job: Job; onChange: (job: Job) => void; locked: boolean }) {
  const id = useId();
  const { send, busy, error } = useSend(job, onChange);
  const [text, setText] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (locked || !text.trim()) return;
    if (await send("messages", { text })) setText("");
  }

  return (
    <form onSubmit={submit} noValidate data-testid="job-chat-message-form" className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field id={`${id}-message`} label="Message the run" value={text} onChange={(e) => setText(e.target.value)}
            disabled={locked} data-testid="job-chat-message-input" />
        </div>
        <Button type="submit" loading={busy} loadingText="Sending…" disabled={locked || !text.trim()} data-testid="job-chat-message-submit">Send</Button>
      </div>
      {locked && <p className="text-xs font-medium text-ink-700">Answer the sign-in form above first.</p>}
      <FormError text={error} testId="job-chat-message-error" />
      <p className="text-xs text-ink-500">Do not type passwords here. The run asks for them in a separate form.</p>
    </form>
  );
}
