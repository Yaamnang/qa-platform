import { config } from "../lib/config";
import { expect, test } from "../lib/test";

/**
 * Tenant isolation, checked without ever touching a real client's data.
 * The QA team owns two synthetic tenants: the bot signs in to one, and the
 * other holds "canary" records with a unique marker. If the bot can ever see
 * a canary, isolation is broken. (The guard fixture also scans every page
 * and API response in every test for the same markers.)
 */
test.describe("Tenant isolation", { tag: ["@security", "@live-safe"] }, () => {
  test("the documents list shows only this tenant's documents", async ({ page }) => {
    await page.goto("/workspace");
    await expect(page.getByTestId("tenant-badge"), "The header should show the QA tenant").toHaveText("Workspace: QA Synthetic");
    await expect(page.getByRole("region", { name: "Your documents" })).not.toContainText("Loading");
    for (const marker of config.canaryMarkers) {
      await expect(
        page.getByText(marker),
        `CRITICAL: a document from another tenant ("${marker}") is listed in the QA workspace`,
      ).toHaveCount(0);
    }
  });

  test("another tenant's document cannot be opened by its ID", async ({ page }) => {
    const res = await page.request.get(`/api/documents/${config.canaryDocId}`);
    expect(res.status(), "Requesting another tenant's document by ID must return 404 (not the document)").toBe(404);
  });

  test("another workspace cannot be opened, and is indistinguishable from one that does not exist", async ({ page }) => {
    // A real workspace the bot is not a member of, and one that was never created.
    // Both must answer identically, otherwise the response itself tells an
    // attacker which workspace ids are real.
    const real = await page.request.post("/api/orgs/select", { data: { organizationId: "t_acme" } });
    const invented = await page.request.post("/api/orgs/select", { data: { organizationId: "t_does_not_exist" } });

    expect(real.status(), "Selecting a workspace the bot does not belong to must be refused").toBe(404);
    expect(
      await invented.json(),
      "A real workspace and an invented one must give the same answer, so neither can be probed for",
    ).toEqual(await real.json());

    // And the refusal must not have moved the session.
    await page.goto("/workspace");
    await expect(page.getByTestId("tenant-badge"), "The bot should still be in its own workspace").toHaveText(
      "Workspace: QA Synthetic",
    );
  });

  test("an unknown analysis link shows a clear 'not found' message", async ({ page }) => {
    await page.goto("/jobs/job_doesnotexist");
    await expect(page.getByRole("main").getByRole("alert"), "An unknown analysis link should say it was not found").toHaveText("Job not found.");
  });
});
