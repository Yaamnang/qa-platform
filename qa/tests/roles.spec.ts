import { config } from "../lib/config";
import { freshCode } from "../lib/totp";
import { expect, fixture, qaName, test } from "../lib/test";
import { chooseOrganization, documentRow, expectSignedInWorkspace, personRow, submitCode, submitPassword } from "../lib/ui";

/**
 * Roles: a Viewer may look but must not change anything. Checked with a second
 * synthetic account that is a Viewer in the QA org (and nowhere else).
 * Hiding buttons is not enough, so the test also calls the API directly, the
 * way a curious user with the browser's developer tools could.
 */

// The Viewer signs in from scratch.
// Traces record typed values, so never trace the steps that type secrets.
test.use({ storageState: { cookies: [], origins: [] }, trace: "off", screenshot: "off", video: "off" });

test.describe("Roles", { tag: ["@roles", "@security", "@live-safe"] }, () => {
  test("a Viewer can see documents but cannot upload, delete or analyse", async ({ page, playwright }, testInfo) => {
    test.skip(!config.viewer.password || !config.viewer.totpSecret, "QA_VIEWER_PASSWORD / QA_VIEWER_TOTP_SECRET not provided");
    // A fresh one-time code can take up to 30 seconds.
    test.setTimeout(testInfo.timeout + 30_000);

    // The QA bot (Admin) arranges and cleans up; the browser is the Viewer.
    const admin = await playwright.request.newContext({
      baseURL: config.baseURL,
      storageState: config.storageState,
      extraHTTPHeaders: { "X-QA-Run": config.runId },
    });
    const createdDocIds: string[] = [];
    const createdInviteIds: string[] = [];

    try {
      const seeded = await admin.post("/api/documents", {
        multipart: { file: { name: qaName("viewer-can-see"), mimeType: "text/csv", buffer: fixture("adverse-events-24.csv") } },
      });
      expect(seeded.status(), "Test setup: the QA bot (Admin) should be able to upload a document").toBe(201);
      const doc = (await seeded.json()).document as { id: string; name: string };
      createdDocIds.push(doc.id);

      await test.step("Sign in as the Viewer with password and a fresh one-time code", async () => {
        await submitPassword(page, config.viewer.email, config.viewer.password);
        await submitCode(page, await freshCode(config.viewer.totpSecret));
        await expect(page, "A valid one-time code should take the Viewer to the organization picker").toHaveURL(/\/orgs$/);
      });

      await test.step("Check the Viewer belongs to the QA organization only, as a Viewer (safety stop)", async () => {
        const res = await page.request.get("/api/orgs");
        expect(res.ok(), `SAFETY STOP: could not list the QA viewer's organizations (GET /api/orgs returned ${res.status()}).`).toBe(true);
        const { organizations } = (await res.json()) as { organizations: { slug: string; name: string; role: string }[] };
        const seen = organizations.map((o) => `${o.slug} (${o.role})`);
        expect(seen, `SAFETY STOP: the QA viewer can open [${seen.join(", ")}], expected only "${config.expectedTenant} (viewer)".`)
          .toEqual([`${config.expectedTenant} (viewer)`]);
        await chooseOrganization(page, organizations[0].name);
        await expectSignedInWorkspace(page, "QA Synthetic");
      });

      await test.step("The Viewer can see the documents list", async () => {
        await expect(documentRow(page, doc.name), "A Viewer should see the organization's documents").toBeVisible();
        await expect(page.getByRole("note").filter({ hasText: "read-only access" }), "The page should tell the Viewer they have read-only access")
          .toBeVisible();
      });

      await test.step("The Viewer gets no upload, delete or analyse controls", async () => {
        await expect(page.getByRole("button", { name: "Upload" }), "A Viewer should not see an Upload button").toHaveCount(0);
        await expect(page.getByLabel("CSV file"), "A Viewer should not get a file picker").toHaveCount(0);
        await expect(page.getByRole("button", { name: `Analyze ${doc.name}` }), "A Viewer should not see an Analyze button").toHaveCount(0);
        await expect(page.getByRole("button", { name: `Delete ${doc.name}` }), "A Viewer should not see a Delete button").toHaveCount(0);
      });

      await test.step("The Viewer can see the team but gets no invite form", async () => {
        await page.getByRole("link", { name: "Team" }).click();
        await expect(personRow(page, config.viewer.email).getByRole("cell").nth(2), "The team page should list the Viewer with the role Viewer")
          .toHaveText("Viewer");
        await expect(page.getByRole("button", { name: "Send invite" }), "A Viewer should not see the invite form").toHaveCount(0);
      });

      await test.step("Try to upload through the API directly: refused with 403", async () => {
        const name = qaName("viewer-upload");
        const res = await page.request.post("/api/documents", {
          multipart: { file: { name, mimeType: "text/csv", buffer: fixture("adverse-events-24.csv") } },
        });
        const body = await res.json().catch(() => ({}));
        if (body.document?.id) createdDocIds.push(body.document.id); // stored anyway: the Admin cleans it up below
        expect(res.status(), "A Viewer (read-only role) must not be able to upload documents: the server should refuse with 403").toBe(403);
        expect(body.error, "The refusal should explain that the Viewer has read-only access").toMatch(/read-only/i);
        const names = ((await (await admin.get("/api/documents")).json()).documents as { name: string }[]).map((d) => d.name);
        expect(names, "The refused upload must not be stored").not.toContain(name);
      });

      await test.step("Try to delete, analyse or invite through the API directly: refused with 403", async () => {
        const del = await page.request.delete(`/api/documents/${doc.id}`);
        expect(del.status(), "A Viewer must not be able to delete a document: the server should refuse with 403").toBe(403);
        const job = await page.request.post("/api/jobs", { data: { documentId: doc.id } });
        expect(job.status(), "A Viewer must not be able to start an AI analysis: the server should refuse with 403").toBe(403);
        const inv = await page.request.post("/api/team/invites", { data: { email: `${qaName("viewer-invite", "")}@synthetic.eclypse.test`, role: "admin" } });
        const invBody = await inv.json().catch(() => ({}));
        if (invBody.invite?.id) createdInviteIds.push(invBody.invite.id);
        expect(inv.status(), "A Viewer must not be able to invite people: the server should refuse with 403").toBe(403);
      });
    } finally {
      for (const id of createdDocIds) await admin.delete(`/api/documents/${id}`).catch(() => {});
      for (const id of createdInviteIds) await admin.delete(`/api/team/invites/${id}`).catch(() => {});
      await admin.dispose();
      await page.request.post("/api/auth/logout").catch(() => {}); // the Viewer's session is worthless afterwards
    }
  });
});
