/**
 * Why a run stopped, in plain words. The runner's own message is precise but
 * technical ("page.goto: net::ERR_CONNECTION_TIMED_OUT at ..."), so the
 * common cases get a short heading and what to do; the original text stays
 * under Details for whoever needs it.
 */

type Explained = { title: string; hint: string };

function hostIn(text: string): string {
  return text.match(/https?:\/\/([^/\s:]+)/)?.[1] ?? "The site";
}

function explain(text: string): Explained | null {
  const host = hostIn(text);
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|Timeout \d+ms exceeded.*goto/i.test(text)) {
    return { title: `Could not reach ${host}`, hint: "It did not answer in time. It may be down or blocked from this network. Try again later." };
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(text)) {
    return { title: `${host} does not exist`, hint: "The address could not be looked up. Check the workspace's target URL for a typo." };
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(text)) {
    return { title: `${host} refused the connection`, hint: "Nothing is answering at that address. Check that the site is running and the port is right." };
  }
  if (/ERR_CERT_|SSL|certificate/i.test(text)) {
    return { title: `${host} has a certificate problem`, hint: "The browser does not trust its HTTPS certificate." };
  }
  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH/i.test(text)) {
    return { title: "No internet connection", hint: "The machine running the console is offline." };
  }
  if (/api\/health did not respond/i.test(text)) {
    return { title: `${host} is not responding`, hint: "Its health check did not answer, so no tests were run." };
  }
  return null;
}

export function RunError({ error, testId }: { error: string | null; testId: string }) {
  const text = error ?? "The job stopped without giving a reason.";
  const explained = explain(text);
  return (
    <section role="alert" data-testid={testId} className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">{explained?.title ?? "The run stopped"}</p>
          <p className="mt-1 text-sm text-amber-900/80">{explained?.hint ?? text}</p>
          {explained && (
            <details className="mt-2 text-xs text-amber-900/70">
              <summary className="cursor-pointer select-none hover:text-amber-900">Details</summary>
              <p className="mt-1 break-words font-mono">{text}</p>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
