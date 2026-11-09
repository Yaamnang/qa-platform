import { config } from "../lib/config";
import { expect, qaName, test } from "../lib/test";
import { inviteThroughUi, personRow } from "../lib/ui";

/** A synthetic address on a reserved test domain: unique per run, never deliverable. */
const syntheticEmail = (label: string) => `${qaName(label, "")}@synthetic.eclypse.test`.toLowerCase();

// Live-safe: every invite the bot sends is cancelled again (by the test, by the
// guard if the test fails, and by the end-of-run sweep as a last resort).
test.describe("Team", { tag: ["@team", "@live-safe"] }, () => {
  test("an admin can invite a teammate as Viewer and cancel the invite", async ({ page }) => {
    const email = syntheticEmail("invite");
    await page.goto("/team");
    await expect(personRow(page, config.email), "The team page should list the QA bot itself as a member").toBeVisible();

    await test.step(`Invite ${email} as Viewer`, async () => {
      await inviteThroughUi(page, email, "Viewer");
      await expect(page.getByRole("main").getByRole("status"), "Inviting should confirm who was invited and with which role")
        .toHaveText(`Invited ${email} as Viewer.`);
    });

    await test.step("The invite is listed as Viewer with status Invited, also after a reload", async () => {
      for (const pass of ["on screen", "after reload"]) {
        if (pass === "after reload") await page.reload();
        const row = personRow(page, email);
        await expect(row, `The invite should be listed on the team page (${pass})`).toBeVisible();
        await expect(row.getByRole("cell").nth(2), `The invite should show the chosen role, Viewer (${pass})`).toHaveText("Viewer");
        await expect(row.getByRole("cell").nth(3), `The invite should show the status Invited (${pass})`).toHaveText("Invited");
      }
    });

    await test.step("Inviting the same email again is refused", async () => {
      await inviteThroughUi(page, email, "Viewer");
      await expect(page.getByRole("main").getByRole("alert"), "A second invite to the same email should be refused with a clear message")
        .toHaveText(`${email} has already been invited.`);
      await expect(personRow(page, email), "The refused duplicate must not add a second row").toHaveCount(1);
    });

    await test.step("Cancel the invite", async () => {
      await page.getByRole("button", { name: `Cancel invite for ${email}` }).click();
      await expect(page.getByRole("main").getByRole("status"), "Cancelling should confirm which invite was cancelled")
        .toHaveText(`Cancelled the invite for ${email}.`);
    });

    await test.step("The invite is gone, also after a reload", async () => {
      for (const pass of ["on screen", "after reload"]) {
        if (pass === "after reload") await page.reload();
        await expect(personRow(page, config.email), `The member list should be loaded (${pass})`).toBeVisible();
        await expect(personRow(page, email), `The cancelled invite should be gone (${pass})`).toHaveCount(0);
      }
    });
  });

  test("an invalid email or an existing member is refused, explained, and not invited", async ({ page }) => {
    const alert = page.getByRole("main").getByRole("alert");
    await page.goto("/team");
    await expect(personRow(page, config.email), "The team page should list the QA bot itself as a member").toBeVisible();

    await test.step("An invalid email is refused and the field says why", async () => {
      await inviteThroughUi(page, "not-an-email", "Viewer");
      await expect(alert, "An invalid email should show a clear error").toHaveText("Please fix the highlighted fields.");
      await expect(page.getByLabel("Email address"), "The invalid field should be marked as invalid").toHaveAttribute("aria-invalid", "true");
      await expect(page.getByText("Enter a valid email address."), "The field should say what is wrong with it").toBeVisible();
    });

    await test.step("Inviting someone who is already a member is refused", async () => {
      await inviteThroughUi(page, config.email, "Viewer");
      await expect(alert, "Inviting an existing member should explain that they are already in the organization")
        .toHaveText(`${config.email.toLowerCase()} is already a member of QA Synthetic.`);
    });

    await test.step("Nothing was invited, also after a reload", async () => {
      await page.reload();
      await expect(personRow(page, config.email), "The QA bot should be listed exactly once").toHaveCount(1);
      await expect(personRow(page, "not-an-email"), "A refused invite must not be listed").toHaveCount(0);
    });
  });
});
