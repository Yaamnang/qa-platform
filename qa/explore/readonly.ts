import type { BrowserContext, Route } from "@playwright/test";
import type { BlockedWrite } from "./types";

/**
 * The read-only guarantee of the setup agent.
 *
 * The explorer visits pages it has never seen, so it cannot know in advance
 * which button deletes a client's data. Instead of trusting itself not to
 * click, it takes the ability away: every request that is not a GET or a HEAD
 * is aborted in the browser before it leaves, whatever triggered it. A stray
 * click, a form that auto-submits, a background fetch on a timer: none of them
 * can reach the server.
 *
 * This is the same idea as the write allow-list in `qa/lib/test.ts`, and it
 * fails the same way: closed. The allow-list here is three entries long because
 * signing in is itself a POST, and it is the only thing the explorer is
 * allowed to do. For sites other than the stand-in there is a short sign-in
 * window instead of a list: see ReadOnlyGuard below. Anything else is
 * refused and recorded as evidence, so a run that quietly tried to write
 * shows up in the map instead of staying invisible.
 *
 * Non-GET requests to other origins are refused too, so the explorer cannot
 * post anything anywhere. GETs to other origins are allowed, otherwise a page
 * that loads a font or a script from a CDN would render wrongly and the map
 * would describe a broken page.
 */

const SIGN_IN_WRITES: Array<[string, RegExp]> = [
  ["POST", /^\/api\/auth\/login$/],
  ["POST", /^\/api\/auth\/verify$/],
  // Opening an organization the account already belongs to. Never creating one.
  ["POST", /^\/api\/orgs\/select$/],
];

/** Longest a sign-in window may stay open, even if nobody closes it. */
export const SIGN_IN_WINDOW_MS = 15_000;

function record(blocked: BlockedWrite[], method: string, path: string): void {
  const seen = blocked.find((b) => b.method === method && b.path === path);
  if (seen) seen.count++;
  else blocked.push({ method, path, count: 1 });
}

/**
 * The one narrow exception to "nothing but GET".
 *
 * A third-party site does not sign in through our stand-in's three endpoints,
 * so the allow-list above cannot cover it, and we cannot know its endpoints in
 * advance. So instead of a list there is a window in time: the sign-in code in
 * crawl.ts opens it immediately before it submits the login form or the code
 * form, and closes it once the page has settled. It also closes by itself
 * after SIGN_IN_WINDOW_MS, so a forgotten close cannot leave the door open.
 *
 * While it is open, a non-GET request to the target's own origin goes
 * through, because that is where a login form posts. Every one of them is
 * logged as "allowed for sign-in: METHOD path", so a reviewer can see exactly
 * what the exception let out. Other origins stay blocked, with one exception:
 * when the login form's action points to a different origin (an identity
 * provider such as accounts.example.com), that one origin is let through too,
 * and logged the same way. Nothing else changes: outside the window the guard
 * is exactly as strict as before, and the explorer still never clicks a
 * submit button anywhere else (agent.ts filters them out).
 */
export type ReadOnlyGuard = {
  /** Opens the sign-in window. identityProvider: the form action's origin, when it is not the target's. */
  openSignInWindow(identityProvider?: string | null): void;
  closeSignInWindow(): void;
};

/**
 * Install the guard. Call this on a fresh context, before the first
 * navigation, so no request can slip out ahead of it.
 */
export async function installReadOnlyGuard(
  context: BrowserContext,
  origin: string,
  blocked: BlockedWrite[],
  log: (line: string) => void = () => {},
): Promise<ReadOnlyGuard> {
  let openUntil = 0;
  let identityProvider: string | null = null;
  const windowOpen = () => Date.now() < openUntil;

  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const method = request.method();
    if (method === "GET" || method === "HEAD") return route.continue();

    const url = new URL(request.url());
    const sameOrigin = url.origin === origin;
    if (sameOrigin && SIGN_IN_WRITES.some(([m, pattern]) => m === method && pattern.test(url.pathname))) {
      return route.continue();
    }
    if (windowOpen() && sameOrigin) {
      log(`  allowed for sign-in: ${method} ${url.pathname}`);
      return route.continue();
    }
    if (windowOpen() && identityProvider && url.origin === identityProvider) {
      log(`  allowed for sign-in (identity provider): ${method} ${url.origin}${url.pathname}`);
      return route.continue();
    }
    record(blocked, method, sameOrigin ? url.pathname : `${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });

  return {
    openSignInWindow(provider) {
      identityProvider = provider && provider !== origin ? provider : null;
      openUntil = Date.now() + SIGN_IN_WINDOW_MS;
    },
    closeSignInWindow() {
      openUntil = 0;
      identityProvider = null;
    },
  };
}
