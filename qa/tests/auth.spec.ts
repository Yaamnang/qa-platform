import { config } from "../lib/config";
import { freshCode, wrongCode } from "../lib/totp";
import { expect, test } from "../lib/test";
import { chooseOrganization, expectSignedInWorkspace, submitCode, submitPassword } from "../lib/ui";

// These tests need a signed-out browser.
// Traces record typed values, so never trace the steps that type secrets.
test.use({ storageState: { cookies: [], origins: [] }, trace: "off", screenshot: "off", video: "off" });

test.describe("Sign-in", { tag: ["@auth", "@live-safe"] }, () => {
  test("signed-out visitors are sent to the sign-in page", async ({ page }) => {
    await page.goto("/workspace");
    await expect(page, "Opening the workspace while signed out should redirect to sign-in").toHaveURL(/\/fake\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in to Eclypse" })).toBeVisible();
  });

  test("a wrong password is refused with a clear message", async ({ page }) => {
    await submitPassword(page, config.email, "definitely-not-the-password");
    await expect(page.getByRole("main").getByRole("alert"), "A wrong password should show a clear error").toHaveText("Incorrect email or password.");
    await expect(page.getByLabel("Authentication code"), "A wrong password must not reach the code step").toHaveCount(0);
  });

  test("a wrong one-time code is refused and the user stays signed out", async ({ page }) => {
    await submitPassword(page, config.email, config.password);
    await submitCode(page, wrongCode());
    await expect(page.getByRole("main").getByRole("alert"), "A wrong one-time code should show a clear error").toContainText("That code is not valid");
    await page.goto("/workspace");
    await expect(page, "A rejected code must not create a session").toHaveURL(/\/fake\/login$/);
  });

  test("a user can sign in with a one-time code and sign out again", async ({ page }) => {
    await test.step("Sign in with password and a fresh one-time code", async () => {
      await submitPassword(page, config.email, config.password);
      await submitCode(page, await freshCode());
    });
    await test.step("Choose the QA organization", async () => {
      await chooseOrganization(page, "QA Synthetic");
      await expectSignedInWorkspace(page, "QA Synthetic");
    });
    await test.step("Sign out", async () => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page, "Signing out should return the user to the sign-in page").toHaveURL(/\/fake\/login$/);
    });
    await test.step("The old session no longer works", async () => {
      await page.goto("/workspace");
      await expect(page, "After signing out, protected pages should redirect to sign-in").toHaveURL(/\/fake\/login$/);
    });
  });
});
