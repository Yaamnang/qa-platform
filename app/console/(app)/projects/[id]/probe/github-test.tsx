"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field } from "@/components/ui";
import { ApiError, postJson } from "@/lib/client/api";
import { GITHUB_NOT_CONNECTED, type Job } from "@/lib/console/contract";
import { errorMessage, isSignedOut } from "../../../../_components/api";

/**
 * Calls onFound once when the address has ?<name> (or ?<name>=<value>), then, with clear, takes it
 * out of the address. In its own Suspense boundary, because useSearchParams
 * makes everything up to the nearest boundary render in the browser only, and
 * the rest of the page should still prerender.
 */
type QueryFlagProps = { name: string; value?: string; clear?: boolean; onFound: () => void };

export function QueryFlag(props: QueryFlagProps) {
  return (
    <Suspense fallback={null}>
      <ReadQueryFlag {...props} />
    </Suspense>
  );
}

function ReadQueryFlag({ name, value, clear = false, onFound }: QueryFlagProps) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const found = value === undefined ? params.has(name) : params.get(name) === value;
  const onFoundRef = useRef(onFound);
  useEffect(() => {
    onFoundRef.current = onFound;
  });
  useEffect(() => {
    if (!found) return;
    onFoundRef.current();
    if (!clear) return;
    const rest = new URLSearchParams(params.toString());
    rest.delete(name);
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [found, clear, name, params, pathname, router]);
  return null;
}

/**
 * The GitHub code test form: asks for a repository link and starts a Probe for
 * the newest commit on its default branch (POST .../github/test). The server
 * checks that the workspace's GitHub account can push to the repo.
 */
export function GithubTest({ projectId, onStarted, onClose }: { projectId: string; onStarted: (job: Job) => void; onClose: () => void }) {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotConnected(false);
    if (!repoUrl.trim()) return setError("Enter the repository link.");
    setBusy(true);
    setError(null);
    try {
      const { job } = await postJson<{ job: Job }>(`/api/console/projects/${projectId}/github/test`, { repoUrl });
      onStarted(job);
      onClose();
    } catch (err) {
      if (isSignedOut(err)) return router.replace("/login");
      setNotConnected(err instanceof ApiError && err.status === 409 && err.message === GITHUB_NOT_CONNECTED);
      setError(errorMessage(err, "Could not start the code test. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate data-testid="github-test" className="mt-4 max-w-xl rounded-lg border border-ink-200 bg-white p-4">
      <Field id="github-test-url" label="GitHub repository link" type="url" inputMode="url" autoComplete="off" spellCheck={false}
        placeholder="https://github.com/owner/repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
        error={error ?? undefined} autoFocus data-testid="github-test-url" />
      {notConnected && (
        <Link href={`/console/projects/${projectId}/github`} data-testid="github-test-connect"
          className="mt-2 inline-block text-sm font-medium text-brand-600 hover:text-brand-700">
          Open the GitHub tab
        </Link>
      )}
      <div className="mt-3 flex gap-2">
        <Button type="submit" size="sm" loading={busy} data-testid="github-test-submit">Run test</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} data-testid="github-test-cancel">Cancel</Button>
      </div>
    </form>
  );
}
