"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CheckIcon, InfoIcon, LockIcon } from "@/components/icons";
import { Button, buttonStyles, Card, Field, formatDate, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { GithubLink, GithubRepo } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../../_components/api";
import { SecretField } from "../../../../_components/SecretField";
import { formatAgo, useNow } from "../../../../_components/format";
import { JobStatusLabel, StatusDot } from "../../../../_components/status";
import { canRetry, InlineLoading, ListSkeleton, LoadError } from "../../../../_components/states";
import { JobSummary, shortSha } from "../job-history";
import { QueryFlag } from "../probe/github-test";
import { useWorkspace, WorkspaceReady, type WorkspaceJob } from "../workspace";

const POLL_MS = 15_000;

/**
 * The GitHub tab. Three states: no token yet, connected without a repo, and
 * a repo and branch chosen. Then one switch, "Check every new commit", decides
 * whether the server polls the branch and runs a Probe on each new commit.
 * This page polls the status to keep "last checked" fresh.
 */
export default function GithubPage() {
  return (
    <WorkspaceReady>
      <GithubContent />
    </WorkspaceReady>
  );
}

/** The page itself. Only rendered once the workspace has loaded. */
function GithubContent() {
  const { project, jobs, reload } = useWorkspace();
  const router = useRouter();
  const base = `/api/console/projects/${project.id}/github`;

  const [github, setGithub] = useState<GithubLink | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; retry: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picking, setPicking] = useState(false);
  // Sent here by the Probe tab's GitHub code test (?from=code-test): go back there once connected.
  const [fromCodeTest, setFromCodeTest] = useState(false);

  // A new GitHub-triggered run shows up as a new lastTriggeredAt: refresh the job list then.
  const lastTriggered = useRef<number | null | undefined>(undefined);
  function update(next: GithubLink) {
    if (lastTriggered.current !== undefined && next.lastTriggeredAt !== lastTriggered.current) reload();
    lastTriggered.current = next.lastTriggeredAt;
    setGithub(next);
  }
  const updateRef = useRef(update);
  useEffect(() => {
    updateRef.current = update;
  });

  useEffect(() => {
    let stopped = false;
    let loaded = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api<{ github: GithubLink }>(base);
        if (stopped) return;
        loaded = true;
        updateRef.current(r.github);
      } catch (err) {
        if (stopped) return;
        if (isSignedOut(err)) return router.replace("/login");
        // After the first load, a failed poll keeps what is on screen and tries again later.
        if (!loaded) return setLoadError({ text: errorMessage(err, "Could not load the GitHub connection."), retry: canRetry(err) });
      }
      timer = setTimeout(load, POLL_MS);
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [base, router, attempt]);

  if (loadError) {
    return (
      <LoadError testId="github-load-error" message={loadError.text}
        onRetry={loadError.retry ? () => { setLoadError(null); setAttempt((n) => n + 1); } : undefined} />
    );
  }
  if (!github) return <InlineLoading label="Loading GitHub connection…" />;

  const runs = jobs.filter((j) => j.kind === "qa" && j.trigger === "github");
  const onChange = (next: GithubLink) => {
    update(next);
    setPicking(false);
  };

  let body: ReactNode;
  if (!github.connected) {
    const connected = (next: GithubLink) => {
      onChange(next);
      if (fromCodeTest && next.connected) router.push(`/console/projects/${project.id}/probe?github-test=1`);
    };
    body = <NotConnected base={base} tokenUrl={github.tokenUrl} onChange={connected} />;
  } else if (!github.repo || picking) {
    body = <PickRepo base={base} github={github} onChange={onChange} onCancel={github.repo ? () => setPicking(false) : undefined} />;
  } else {
    body = <Watching base={base} github={github} onChange={onChange} onPick={() => setPicking(true)} onStarted={reload} />;
  }

  return (
    <>
      <QueryFlag name="from" value="code-test" onFound={() => setFromCodeTest(true)} />
      {fromCodeTest && !github.connected && (
        <p data-testid="github-test-from-note" className="text-sm text-ink-700">Connect GitHub to run a code test.</p>
      )}
      {body}
      {(github.repo || runs.length > 0) && <GithubRuns runs={runs} />}
      <p data-testid="github-access-note" className="flex items-start gap-1.5 text-xs text-ink-500">
        <InfoIcon className="mt-px size-3.5 shrink-0" />
        The token gives access to every repository your account can see.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Not connected: create a token on GitHub and paste it here
// ---------------------------------------------------------------------------

function NotConnected({ base, tokenUrl, onChange }: { base: string; tokenUrl: string; onChange: (g: GithubLink) => void }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!token.trim()) return setError("Paste the token from GitHub.");
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ github: GithubLink }>(`${base}/token`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      // The server has it now. Drop it from the page before moving on.
      setToken("");
      onChange(r.github);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      // 422: GitHub refused the token or it lacks access. The API says which.
      setError(errorMessage(err, "Could not save the token. Try again."));
      setSaving(false);
    }
  }

  return (
    <Card title="Connect GitHub">
      <div data-testid="github-not-connected" className="space-y-6">
        <div className="space-y-2">
          <a href={tokenUrl} target="_blank" rel="noreferrer" data-testid="github-create-token" className={buttonStyles("secondary")}>
            Create token on GitHub
          </a>
          <p className="text-xs text-ink-500">Name and permission come filled in.</p>
        </div>

        <form onSubmit={save} noValidate autoComplete="off" data-testid="github-token-form" className="max-w-md space-y-4">
          <SecretField id="github-token" label="Paste the token" testId="github-token" className="font-mono"
            autoComplete="off" value={token} error={error ?? undefined}
            onChange={(e) => { setToken(e.target.value); setError(null); }} />
          <Button type="submit" loading={saving} data-testid="github-token-save">Save</Button>
        </form>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Disconnect, shared by the two connected states
// ---------------------------------------------------------------------------

function Disconnect({ base, onChange, small = false }: { base: string; onChange: (g: GithubLink) => void; small?: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ github: GithubLink }>(base, { method: "DELETE" });
      onChange(r.github);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      setError(errorMessage(err, "Could not disconnect. Try again."));
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="ghost" size={small ? "sm" : "md"} onClick={() => setConfirming(true)} data-testid="github-disconnect">
        Disconnect
      </Button>
    );
  }
  return (
    <div data-testid="github-disconnect-confirm" className="w-full space-y-3 rounded-lg border border-ink-200 p-4">
      <p className="text-sm text-ink-700">Disconnect GitHub? The token and the repo are forgotten.</p>
      {error && <Notice kind="error" testId="github-disconnect-error">{error}</Notice>}
      <div className="flex gap-2">
        <Button variant="danger" size="sm" onClick={disconnect} loading={busy} data-testid="github-disconnect-yes">Disconnect</Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy} data-testid="github-disconnect-cancel">Cancel</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State 3: connected, pick a repository and branch
// ---------------------------------------------------------------------------

function PickRepo({ base, github, onChange, onCancel }: {
  base: string;
  github: GithubLink;
  onChange: (g: GithubLink) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(github.repo);
  const [branch, setBranch] = useState(github.branch ?? "");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ repos: GithubRepo[] }>(`${base}/repos`)
      .then((r) => !cancelled && setRepos(r.repos))
      .catch((err) => {
        if (cancelled) return;
        if (isSignedOut(err)) router.replace("/login");
        else setLoadError(errorMessage(err, "Could not load your repositories."));
      });
    return () => {
      cancelled = true;
    };
  }, [base, router, attempt]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  function pick(repo: GithubRepo) {
    setPicked(repo.fullName);
    setBranch(repo.defaultBranch);
    setBranchError(null);
  }

  async function watch(e: FormEvent) {
    e.preventDefault();
    if (!picked) return;
    if (!branch.trim()) return setBranchError("Enter a branch.");
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api<{ github: GithubLink }>(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: picked, branch: branch.trim() }),
      });
      onChange(r.github);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      setSaveError(errorMessage(err, "Could not save. Try again."));
      setSaving(false);
    }
  }

  return (
    <Card title="Pick a repository"
      action={
        <StatusDot tone="pass" testId="github-account" className="text-sm text-ink-700">
          Connected as <span className="font-mono text-ink-900">{github.account ?? "–"}</span>
        </StatusDot>
      }>
      <form onSubmit={watch} noValidate data-testid="github-pick" className="space-y-5">
        {loadError ? (
          <LoadError testId="github-repos-error" message={loadError} onRetry={() => { setLoadError(null); setAttempt((n) => n + 1); }} />
        ) : repos === null ? (
          <ListSkeleton label="Loading repositories" />
        ) : (
          <div className="space-y-3">
            <Field id="github-repo-search" label="Repository" type="search" value={query} autoComplete="off" spellCheck={false}
              onChange={(e) => setQuery(e.target.value)} data-testid="github-repo-search" />
            {shown.length === 0 ? (
              <p data-testid="github-repos-empty" className="text-sm text-ink-500">
                {repos.length === 0 ? "This account cannot see any repositories." : "No repository matches."}
              </p>
            ) : (
              <ul data-testid="github-repos" className="max-h-72 divide-y divide-ink-100 overflow-auto rounded-lg border border-ink-200">
                {shown.map((r) => {
                  const selected = r.fullName === picked;
                  return (
                    <li key={r.fullName}>
                      <button type="button" onClick={() => pick(r)} aria-pressed={selected}
                        data-testid="github-repo" data-repo={r.fullName}
                        className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500 ${
                          selected ? "bg-brand-50 text-ink-900" : "text-ink-700 hover:bg-ink-100/60"
                        }`}>
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{r.fullName}</span>
                        {r.private && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-500">
                            <LockIcon className="size-3.5" /> Private
                          </span>
                        )}
                        {selected && <CheckIcon className="size-4 shrink-0 text-brand-600" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {picked && (
          <Field id="github-branch" label="Branch" value={branch} error={branchError ?? undefined} className="font-mono"
            autoComplete="off" spellCheck={false}
            onChange={(e) => { setBranch(e.target.value); setBranchError(null); }} data-testid="github-branch" />
        )}

        {saveError && <Notice kind="error" testId="github-save-error">{saveError}</Notice>}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={saving} disabled={!picked} data-testid="github-watch">Save</Button>
          {onCancel && <Button variant="ghost" onClick={onCancel} disabled={saving} data-testid="github-pick-cancel">Cancel</Button>}
          <div className="ml-auto"><Disconnect base={base} onChange={onChange} small /></div>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// State 4: repo and branch chosen
// ---------------------------------------------------------------------------

function Watching({ base, github, onChange, onPick, onStarted }: {
  base: string;
  github: GithubLink;
  onChange: (g: GithubLink) => void;
  onPick: () => void;
  onStarted: () => void;
}) {
  const router = useRouter();
  const now = useNow(15_000);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setCheckError(null);
    setStartedJobId(null);
    try {
      const r = await api<{ github: GithubLink; startedJobId: string | null }>(`${base}/check`, { method: "POST" });
      onChange(r.github);
      if (r.startedJobId) {
        setStartedJobId(r.startedJobId);
        onStarted();
      }
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      setCheckError(errorMessage(err, "Could not check the branch. Try again."));
    } finally {
      setChecking(false);
    }
  }

  const ago = (ms: number | null) => (ms === null ? "Never" : now ? formatAgo(ms, now) : formatDate(ms));

  return (
    <Card title="Connected"
      action={
        <StatusDot tone="pass" testId="github-account" className="text-sm text-ink-700">
          <span className="font-mono text-ink-900">{github.account ?? "–"}</span>
        </StatusDot>
      }>
      <AutoCheck base={base} on={github.autoCheck} onChange={onChange} />

      <dl data-testid="github-watching" className="mt-5 grid gap-4 border-t border-ink-200 pt-5 text-sm sm:grid-cols-2">
        <Fact label="Repository"><span data-testid="github-repo-name" className="font-mono text-[13px]">{github.repo}</span></Fact>
        <Fact label="Branch"><span data-testid="github-branch-name" className="font-mono text-[13px]">{github.branch}</span></Fact>
        <Fact label="Last checked">
          <span data-testid="github-last-checked" title={github.lastCheckedAt ? formatDate(github.lastCheckedAt) : undefined}>
            {ago(github.lastCheckedAt)}
          </span>
        </Fact>
        <Fact label="Last commit seen">
          <span data-testid="github-last-sha" className="font-mono text-[13px]">{github.lastSeenSha ? shortSha(github.lastSeenSha) : "–"}</span>
        </Fact>
      </dl>

      {checkError && <Notice kind="error" className="mt-5" testId="github-check-error">{checkError}</Notice>}
      {startedJobId && (
        <p data-testid="github-check-started" className="mt-5 text-sm text-ink-700">
          New commit found.{" "}
          <Link href={`/console/jobs/${startedJobId}`} data-testid="github-check-job" className="font-medium text-brand-600 hover:text-brand-700">
            Open the probe
          </Link>
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-start gap-2 border-t border-ink-200 pt-5">
        <Button variant="secondary" onClick={check} loading={checking} data-testid="github-check">Check now</Button>
        <Button variant="ghost" onClick={onPick} disabled={checking} data-testid="github-change-repo">Change repo</Button>
        <div className="sm:ml-auto"><Disconnect base={base} onChange={onChange} /></div>
      </div>
    </Card>
  );
}

/**
 * The "Check every new commit" switch. Same pattern as Full access on the
 * Probe tab: a button with role="switch", saved straight away, an inline error
 * under it if the save fails. Off keeps the connection; only the poller stops.
 */
function AutoCheck({ base, on, onChange }: { base: string; on: boolean; onChange: (g: GithubLink) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(autoCheck: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ github: GithubLink }>(base, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoCheck }),
      });
      onChange(r.github);
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      // On Supabase without the new column, the API says which SQL to run.
      setError(errorMessage(err, "Could not save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="github-auto-check-row">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" role="switch" aria-checked={on} aria-labelledby="github-auto-check-label"
          aria-describedby="github-auto-check-state" aria-busy={busy} disabled={busy}
          onClick={() => save(!on)} data-testid="github-auto-check"
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-brand-600" : "bg-ink-300"}`}>
          <span aria-hidden="true" className={`size-4 rounded-full bg-white transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
        </button>
        <span id="github-auto-check-label" className="text-sm font-medium text-ink-900">Check every new commit</span>
        <span id="github-auto-check-state" data-testid="github-auto-check-state" className="text-xs text-ink-500">
          {busy
            ? "Saving…"
            : on
              ? "A Probe runs on each new commit and the result shows on the commit in GitHub."
              : "Off. Nothing runs by itself."}
        </span>
      </div>
      {error && <Notice kind="error" className="mt-3" testId="github-auto-check-error">{error}</Notice>}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-500">{label}</dt>
      <dd className="mt-1 truncate text-ink-800">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probes GitHub started
// ---------------------------------------------------------------------------

const RUN_COLUMNS = "sm:grid sm:grid-cols-[7rem_5rem_minmax(0,1fr)_minmax(0,1.2fr)_4rem] sm:items-center sm:gap-4";

function GithubRuns({ runs }: { runs: WorkspaceJob[] }) {
  return (
    <Card title="Runs from GitHub" bodyClassName="">
      {runs.length === 0 ? (
        <p data-testid="github-runs-empty" className="px-5 py-6 text-sm text-ink-500">No runs from GitHub yet.</p>
      ) : (
        <>
          <div aria-hidden="true" className={`hidden border-b border-ink-100 px-5 py-2.5 text-xs font-medium text-ink-500 ${RUN_COLUMNS}`}>
            <span>Status</span><span>Commit</span><span>Branch</span><span>Result</span><span />
          </div>
          <ul data-testid="github-runs" className="divide-y divide-ink-100">
            {runs.map((job) => (
              <li key={job.id} data-testid="github-run-row" data-job-id={job.id}
                className={`space-y-1 px-5 py-3 text-sm sm:space-y-0 ${RUN_COLUMNS}`}>
                <span className="block text-ink-700"><JobStatusLabel job={job} /></span>
                <Link href={`/console/jobs/${job.id}`} data-testid="github-run-job" title={formatDate(job.createdAt)}
                  className="block font-mono text-[13px] text-brand-600 hover:text-brand-700">
                  {job.commit ? shortSha(job.commit.sha) : job.id.slice(0, 7)}
                </Link>
                <span className="block truncate font-mono text-[13px] text-ink-600">{job.commit?.ref ?? "–"}</span>
                <span className="block truncate text-ink-600"><JobSummary job={job} /></span>
                <span className="block sm:text-right">
                  {job.commit?.runUrl && (
                    <a href={job.commit.runUrl} target="_blank" rel="noreferrer" data-testid="github-run-commit"
                      className="font-medium text-ink-500 underline-offset-4 hover:text-ink-900 hover:underline">
                      Commit
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
