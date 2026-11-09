import { config } from "../lib/config";
import { expect, test } from "../lib/test";

test.describe("Settings", { tag: ["@settings", "@live-safe"] }, () => {
  test("profile changes are saved and survive a reload", async ({ page }) => {
    await page.goto("/settings");
    const nameField = page.getByLabel("Display name");
    await expect(nameField).not.toHaveValue("");
    const original = await nameField.inputValue();
    const changed = `QA Bot ${config.runId.slice(-6)}`;

    try {
      await test.step(`Change display name to "${changed}" and save`, async () => {
        await nameField.fill(changed);
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByRole("main").getByRole("status"), "Saving should confirm the change").toHaveText("Settings saved.");
      });
      await test.step("Reload: the new name is still there", async () => {
        await page.reload();
        await expect(
          page.getByLabel("Display name"),
          "The page said 'Settings saved', so the new display name should still be there after a reload",
        ).toHaveValue(changed);
      });
    } finally {
      // Leave the bot's profile as we found it (important on shared environments).
      await page.request.put("/api/settings", {
        data: { displayName: original, notificationEmail: await page.getByLabel("Notification email").inputValue() },
      });
    }
  });

  test("an invalid email is refused, explained, and not saved", async ({ page }) => {
    await page.goto("/settings");
    const emailField = page.getByLabel("Notification email");
    await expect(emailField).not.toHaveValue("");
    const original = await emailField.inputValue();

    await emailField.fill("not-an-email");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("main").getByRole("alert"), "An invalid email should show a clear error").toHaveText("Please fix the highlighted fields.");
    await expect(emailField, "The invalid field should be marked as invalid").toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Enter a valid email address."), "The field should say what is wrong with it").toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Notification email"), "A refused change must not be saved").toHaveValue(original);
  });
});
