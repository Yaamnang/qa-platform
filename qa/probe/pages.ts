import { isSignInScreen, pathOf, walk } from "../explore/crawl";
import { CRAWL_SECONDS, MAX_DEPTH, MAX_PAGES } from "./limits";
import type { PlanPage } from "./plan";
import type { ProbeSession } from "./session";
import { readScreenOf } from "./snapshot";

/**
 * What the AI Probe plans from: every page it can reach.
 *
 *  1. Sign in first, at the sign-in page (the gate finds it: see
 *     findSignInPage in qa/explore/crawl.ts). A sign-up form is never filled.
 *  2. Walk the site with Explore's crawler, from the signed-in landing page
 *     and from the start page: nav, in-page links and tabs, by URL only. It
 *     never clicks, skips sign-out and destructive links, downloads, mailto,
 *     tel and other hosts, and opens at most two pages per pattern, so a list
 *     of 500 rows is one page.
 *  3. Read each new page pattern the way the planner sees it (snapshot.ts).
 *
 * Stops at MAX_PAGES, MAX_DEPTH or CRAWL_SECONDS (limits.ts).
 */
export type SitePages = {
  pages: PlanPage[];
  /** Pages opened, which can be more than patterns. */
  opened: number;
  stoppedBecause: string;
  notVisited: string[];
};

export async function explorePages(options: {
  session: ProbeSession;
  origin: string;
  start: string;
  log: (line: string) => void;
  notes: string[];
}): Promise<SitePages> {
  const { session, origin, start, log, notes } = options;
  const { page, gate } = session;

  await gate.seekAndSignIn(page, start);
  const landing = gate.signedIn && new URL(page.url()).origin === origin ? pathOf(page) : null;
  const starts = [...new Set([landing, start].filter((p): p is string => !!p))];

  const byPattern = new Map<string, PlanPage>();
  const walked = await walk({
    page,
    gate,
    apiCalls: new Set(),
    notes,
    origin,
    starts,
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    budgetMs: CRAWL_SECONDS * 1000,
    log,
    afterVisit: async (map) => {
      if (new URL(page.url()).origin !== origin || byPattern.has(map.template)) return;
      // Signed in, a sign-in form on screen means the session was lost: not a page to plan.
      if (gate.signedIn && (await isSignInScreen(page))) return;
      const screen = await readScreenOf(page).catch(() => null);
      if (screen) byPattern.set(map.template, { page: map.template, example: map.route, screen });
    },
  });
  return { pages: [...byPattern.values()], opened: walked.pages.length, stoppedBecause: walked.stoppedBecause, notVisited: walked.notVisited };
}
