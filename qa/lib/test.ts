import { readFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { config, QA_PREFIX, ROOT } from "./config";
import { attachLiveView, liveAction } from "./live-view";

/**
 * Every test runs inside a "guard" that:
 *  1. only lets the browser send write requests the QA bot is allowed to make,
 *     and only lets it delete documents and cancel invites it created itself
 *     (fail closed);
 *  2. scans every API response and the final page for canary markers from
 *     another tenant (proof of a cross-tenant data leak);
 *  3. turns uncaught JavaScript errors and 5xx responses into clear failures;
 *  4. cleans up everything the test created, even when the test fails.
 *
 * Problems found by the guard are recorded as annotations so the report can
 * show them as the root cause, ahead of the assertion that tripped later.
 */

export type Guard = {
  createdDocIds: Set<string>;
  createdInviteIds: Set<string>;
  violations: string[];
  consoleErrors: string[];
};

type DocDto = { id: string; name: string; rows: number };

export type QaApi = {
  /** Arrange step through the API (fast, and keeps failures attributable). */
  seedDocument(fileName: string, csv: string | Buffer): Promise<DocDto>;
  listDocuments(): Promise<DocDto[]>;
};

const ALLOWED_WRITES: Array<[string, RegExp]> = [
  ["POST", /^\/api\/auth\/(login|verify|logout)$/],
  ["POST", /^\/api\/orgs\/select$/], // open an organization (never create one)
  ["POST", /^\/api\/documents$/],
  ["POST", /^\/api\/jobs$/],
  ["PUT", /^\/api\/settings$/],
  ["DELETE", /^\/api\/documents\/[\w-]+$/],
  ["POST", /^\/api\/team\/invites$/],
  ["DELETE", /^\/api\/team\/invites\/[\w-]+$/],
  // Sign-up creates accounts that cannot be deleted, so it is only allowed
  // against the local stand-in, never staging or live.
  ...(config.target === "local" ? [["POST", /^\/api\/auth\/(signup|setup)$/] as [string, RegExp]] : []),
];

function recordViolation(g: Guard, testInfo: TestInfo, message: string) {
  if (g.violations.includes(message)) return;
  g.violations.push(message);
  testInfo.annotations.push({ type: "guard", description: message });
}

let nameCounter = 0;
/** Unique, recognisable name for anything the bot creates. */
export function qaName(label: string, ext = ".csv"): string {
  nameCounter++;
  return `${QA_PREFIX}${config.runId}-${label}-${process.pid}-${nameCounter}${ext}`;
}

export function fixture(name: string): Buffer {
  return readFileSync(path.join(ROOT, "qa", "fixtures", name));
}

export const test = base.extend<{ guard: Guard; qaApi: QaApi; liveView: void }>({
  guard: [
    async ({ context, page }, use, testInfo) => {
      const g: Guard = { createdDocIds: new Set(), createdInviteIds: new Set(), violations: [], consoleErrors: [] };
      const pending: Promise<unknown>[] = [];
      const origin = new URL(config.baseURL).origin;

      // 1. Write allow-list. GETs pass; anything else must be expected.
      await context.route(
        (url) => url.origin === origin && url.pathname.startsWith("/api/"),
        async (route: Route) => {
          const req = route.request();
          const method = req.method();
          const pathname = new URL(req.url()).pathname;
          if (method === "GET" || method === "HEAD") return route.continue();

          const allowed = ALLOWED_WRITES.some(([m, re]) => m === method && re.test(pathname));
          if (!allowed) {
            recordViolation(g, testInfo, `SAFETY: blocked ${method} ${pathname}: not on the QA bot's allow-list.`);
            return route.abort("blockedbyclient");
          }
          if (method === "DELETE") {
            await Promise.allSettled(pending); // make sure uploads and invites seen so far are registered
            const id = pathname.split("/").pop()!;
            const isInvite = pathname.startsWith("/api/team/invites/");
            if (!(isInvite ? g.createdInviteIds : g.createdDocIds).has(id)) {
              const what = isInvite ? `cancelling invite ${id}` : `deleting document ${id}`;
              recordViolation(g, testInfo, `SAFETY: blocked ${what}: the QA bot did not create it.`);
              return route.abort("blockedbyclient");
            }
          }
          return route.continue();
        },
      );

      // 2 + 3. Inspect responses: canaries, server errors, bot-created documents.
      context.on("response", (res) => {
        const url = new URL(res.url());
        if (url.origin !== origin) return;
        if (res.status() >= 500) {
          recordViolation(g, testInfo, `Server error ${res.status()} on ${res.request().method()} ${url.pathname}.`);
        }
        const type = res.headers()["content-type"] ?? "";
        if (!/json|html|csv|text/.test(type)) return;
        pending.push(
          res
            .text()
            .then((body) => {
              for (const marker of config.canaryMarkers) {
                if (body.includes(marker)) {
                  recordViolation(
                    g,
                    testInfo,
                    `CRITICAL: data from another tenant reached the QA account (canary "${marker}" in ${res.request().method()} ${url.pathname}).`,
                  );
                }
              }
              if (res.request().method() === "POST" && url.pathname === "/api/documents" && res.status() === 201) {
                const id = JSON.parse(body)?.document?.id;
                if (id) g.createdDocIds.add(id);
              }
              if (res.request().method() === "POST" && url.pathname === "/api/team/invites" && res.status() === 201) {
                const id = JSON.parse(body)?.invite?.id;
                if (id) g.createdInviteIds.add(id);
              }
            })
            .catch(() => {}),
        );
      });

      page.on("pageerror", (err) => {
        recordViolation(g, testInfo, `The page crashed with an uncaught JavaScript error on ${new URL(page.url()).pathname}: ${err.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") g.consoleErrors.push(msg.text());
      });

      await use(g);

      // Final DOM canary scan (catches leaks rendered from any source).
      if (!page.isClosed()) {
        const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
        for (const marker of config.canaryMarkers) {
          if (text.includes(marker)) {
            recordViolation(g, testInfo, `CRITICAL: another tenant's data was visible on screen at ${new URL(page.url()).pathname} (canary "${marker}").`);
          }
        }
      }
      await Promise.allSettled(pending);

      // 4. Clean up only what this test created.
      for (const id of g.createdDocIds) {
        await page.request.delete(`/api/documents/${id}`).catch(() => {});
      }
      for (const id of g.createdInviteIds) {
        await page.request.delete(`/api/team/invites/${id}`).catch(() => {});
      }

      // Console errors are evidence, not failures: browsers log expected 4xx
      // responses too, and failing on them would raise false alarms.
      if (g.consoleErrors.length) {
        await testInfo.attach("browser-console-errors.txt", { body: g.consoleErrors.join("\n"), contentType: "text/plain" });
      }
      if (g.violations.length && testInfo.status === testInfo.expectedStatus) {
        throw new Error(g.violations.join("\n"));
      }
    },
    { auto: true },
  ],

  // The console's live view of this test's browser (qa/lib/live-view.ts). Does
  // nothing unless the run was started from the console. The caption starts
  // as the journey's name; the helpers in ui.ts name each step after that.
  liveView: [
    async ({ page }, use, testInfo) => {
      const stop = attachLiveView(page);
      await liveAction(page, testInfo.titlePath.slice(1).join(" \u203a ") || testInfo.title);
      await use();
      stop();
    },
    { auto: true },
  ],

  qaApi: async ({ page, guard }, use) => {
    await use({
      async seedDocument(fileName, csv) {
        const res = await page.request.post("/api/documents", {
          multipart: { file: { name: fileName, mimeType: "text/csv", buffer: Buffer.from(csv) } },
        });
        expect(res.status(), `Test setup: uploading ${fileName} through the API should succeed`).toBe(201);
        const { document } = await res.json();
        guard.createdDocIds.add(document.id);
        return document;
      },
      async listDocuments() {
        const res = await page.request.get("/api/documents");
        return (await res.json()).documents;
      },
    });
  },
});

export { expect };

/** Read the visible findings table into { metric: valueText }. */
export async function readFindings(page: Page): Promise<Record<string, string>> {
  const rows = page.locator("tr[data-metric]");
  const out: Record<string, string> = {};
  for (const row of await rows.all()) {
    const metric = (await row.getAttribute("data-metric"))!;
    out[metric] = (await row.locator("td").nth(1).innerText()).trim();
  }
  return out;
}
