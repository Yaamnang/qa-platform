import { chromium, type Browser, type BrowserContext, type Download, type Page } from "@playwright/test";
import { settle, signInGate, type Credentials, type SignInGate } from "../explore/crawl";
import { installReadOnlyGuard, type ReadOnlyGuard } from "../explore/readonly";
import type { BlockedWrite } from "../explore/types";
import { attachLiveView, liveAction } from "../lib/live-view";

/**
 * The AI Probe's browser. Unlike Explore it accepts downloads, because
 * "the file really arrived" is one of the things it checks.
 *
 * Without Full access (lib/console/server/projects.ts) it installs the same read-only guard
 * as Explore, on a fresh context before the first request, sign-in window
 * included: every request that is not GET or HEAD is aborted in the browser.
 * Downloads and navigation are GETs, so they still work and can be verified.
 * With Full access writes go through, like the built-in suite.
 *
 * Signing in uses Explore's generic sign-in gate: only when a sign-in screen
 * is reached, once, asking the employee in the job chat when no login is saved.
 */

export type Watch = {
  /** Same-origin requests and navigations seen so far. */
  requests: number;
  dialogs: number;
  newPages: number;
  downloads: Download[];
};

export type ProbeSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  gate: SignInGate;
  blocked: BlockedWrite[];
  watch: Watch;
  close(): Promise<void>;
};

/** Counts DOM changes in the page, ignoring the elements Playwright itself adds (screenshot masks). A string, so the compiler leaves it alone. */
const CHANGE_COUNTER = `
globalThis.__name = globalThis.__name || ((fn) => fn);
(() => {
  if (window.__probeMutationCount !== undefined) return;
  window.__probeMutationCount = 0;
  const ours = (node) => !!node && node.nodeType === 1 && /^X-PW-/.test(node.tagName);
  const start = () => {
    new MutationObserver((list) => {
      for (const m of list) {
        if (ours(m.target) || (m.target.parentElement && ours(m.target.parentElement))) continue;
        if (m.type === "childList" && [...m.addedNodes, ...m.removedNodes].every(ours)) continue;
        window.__probeMutationCount++;
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  start();
})();
`;

const NO_GUARD: ReadOnlyGuard = { openSignInWindow() {}, closeSignInWindow() {} };

export async function openProbeSession(options: {
  origin: string;
  start: string;
  credentials: Credentials;
  readOnly: boolean;
  headed: boolean;
  log: (line: string) => void;
  notes: string[];
}): Promise<ProbeSession> {
  const browser = await chromium.launch({ headless: !options.headed });
  let stopLiveView = () => {};
  const close = async () => {
    stopLiveView();
    await browser.close().catch(() => {});
  };
  try {
    const context = await browser.newContext({
      baseURL: options.origin,
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
      locale: "en-GB",
      timezoneId: "UTC",
      extraHTTPHeaders: { "X-QA-Run": `ai-probe-${new Date().toISOString()}` },
    });
    const blocked: BlockedWrite[] = [];
    const guard = options.readOnly ? await installReadOnlyGuard(context, options.origin, blocked, options.log) : NO_GUARD;
    await context.addInitScript({ content: CHANGE_COUNTER });

    const watch: Watch = { requests: 0, dialogs: 0, newPages: 0, downloads: [] };
    context.on("request", (request) => {
      const type = request.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) return;
      if (new URL(request.url()).origin === options.origin || request.isNavigationRequest()) watch.requests++;
    });
    const page = await context.newPage();
    // A new tab is a visible effect of a click. It is counted and closed: the probe follows one tab.
    context.on("page", (other) => {
      if (other === page) return;
      watch.newPages++;
      void other.close().catch(() => {});
    });
    // Native dialogs (alert, confirm) are counted and dismissed, so a confirm("Delete?") answers no.
    page.on("dialog", (dialog) => {
      watch.dialogs++;
      void dialog.dismiss().catch(() => {});
    });
    page.on("download", (download) => watch.downloads.push(download));

    stopLiveView = attachLiveView(page);
    options.log(`• Opening ${options.origin}${options.start} as a signed-out visitor…`);
    await liveAction(page, `Opening ${options.start}`);
    await page.goto(options.start, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settle(page);
    const gate = signInGate({ origin: options.origin, credentials: options.credentials, log: options.log, guard, notes: options.notes });
    return { browser, context, page, gate, blocked, watch, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function blockedCount(blocked: BlockedWrite[]): number {
  return blocked.reduce((sum, b) => sum + b.count, 0);
}
