import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { config, QA_PREFIX } from "../lib/config";
import { codeForStep } from "../lib/totp";
import { expect, test } from "../lib/test";
import { submitPassword } from "../lib/ui";

// These tests need a signed-out browser and must not leave traces with secrets.
test.use({ storageState: { cookies: [], origins: [] }, trace: "off", screenshot: "off", video: "off" });

type SignupDetails = { name: string; email: string; password: string; confirmPassword: string };

/** A new synthetic address for every attempt, so a rerun never meets the account of an earlier attempt. */
function newEmail(label: string): string {
  return `${QA_PREFIX}${config.runId}-${label}-${randomBytes(3).toString("hex")}@synthetic.eclypse.test`.toLowerCase();
}

/** A throw-away password for an account that only exists for this test. */
const newPassword = () => `qa-${randomBytes(12).toString("base64url")}`;

/** The 6-digit code an authenticator app would show right now for this key. */
const codeNow = (secret: string) => codeForStep(secret, Math.floor(Date.now() / 30_000));

async function submitSignup(page: Page, details: SignupDetails) {
  await page.getByLabel("Full name").fill(details.name);
  await page.getByLabel("Email").fill(details.email);
  await page.getByLabel("Password", { exact: true }).fill(details.password);
  await page.getByLabel("Confirm password", { exact: true }).fill(details.confirmPassword);
  await page.getByRole("button", { name: "Create account" }).click();
}

test.describe("Sign-up", { tag: ["@auth"] }, () => {
  // Not @live-safe: every run creates an account that cannot be deleted.
  // So it only runs against the local stand-in, never staging or live.
  test.skip(config.target !== "local", "Sign-up creates real accounts, so it only runs against the local stand-in");

  test("a new person can sign up, connect an authenticator and land signed in", async ({ page }) => {
    const email = newEmail("signup");
    const password = newPassword();
    let secret = "";

    await test.step("Fill in the sign-up form", async () => {
      await page.goto("/signup");
      await submitSignup(page, { name: "QA Synthetic Person", email, password, confirmPassword: password });
      await expect(page, "Creating an account should move on to the authenticator step").toHaveURL(/\/signup\/authenticator$/);
    });

    await test.step("Read the authenticator key shown next to the QR code", async () => {
      await expect(page.getByRole("img", { name: "QR code for your authenticator app" }), "The page should show a QR code to scan").toBeVisible();
      await expect(page.getByText(`Account: ${email}`), "The page should show which account is being set up").toBeVisible();
      secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "");
      // Checked as true/false so a failure never prints the key itself.
      expect(/^[A-Z2-7]{16,}$/.test(secret), "The key under the QR code should be a valid authenticator key").toBe(true);
    });

    await test.step("Enter the code an authenticator app would show for that key", async () => {
      await page.getByLabel("Enter the 6-digit code").fill(codeNow(secret));
      await page.getByRole("button", { name: "Confirm and continue" }).click();
      const shownError = page.getByRole("main").getByRole("alert");
      await expect(page, "A valid first code should finish sign-up and open the organization page")
        .toHaveURL(/\/orgs$/)
        .catch(async (e) => {
          if (await shownError.count()) throw new Error(`The first code from the shown key was refused: "${await shownError.innerText()}"`);
          throw e;
        });
    });

    await test.step("The new account is signed in and has no organizations yet", async () => {
      await expect(page.getByRole("heading", { name: "Create your organization" }), "A brand-new account should be asked to create its first organization").toBeVisible();
      const res = await page.request.get("/api/orgs");
      expect(res.ok(), `The new account should be signed in (GET /api/orgs returned ${res.status()})`).toBe(true);
      const { user, organizations } = (await res.json()) as { user: { email: string }; organizations: unknown[] };
      expect(user.email, "The session should belong to the account that just signed up").toBe(email);
      expect(organizations, "A brand-new account should not belong to any organization").toEqual([]);
    });
  });

  test("the sign-up form refuses bad input and explains what to fix", async ({ page }) => {
    const email = newEmail("signup-bad");
    const password = newPassword();
    await page.goto("/signup");

    await test.step("Submit a password that is too short", async () => {
      await submitSignup(page, { name: "QA Synthetic Person", email, password: "short-pw", confirmPassword: "short-pw" });
      await expect(page.getByLabel("Password", { exact: true }), "A short password should be refused with a clear reason")
        .toHaveAccessibleDescription("Use at least 12 characters.");
      await expect(page.getByRole("main").getByRole("alert"), "The form should say there is something to fix").toHaveText("Please fix the highlighted fields.");
      await expect(page, "A refused form should stay on the sign-up page").toHaveURL(/\/signup$/);
    });

    await test.step("Submit two passwords that do not match", async () => {
      await submitSignup(page, { name: "QA Synthetic Person", email, password, confirmPassword: `${password}-typo` });
      await expect(page.getByLabel("Confirm password", { exact: true }), "Passwords that do not match should be refused with a clear reason")
        .toHaveAccessibleDescription("The passwords do not match.");
      await expect(page, "A refused form should stay on the sign-up page").toHaveURL(/\/signup$/);
    });

    await test.step("No account was created", async () => {
      await submitPassword(page, email, password);
      await expect(page.getByRole("main").getByRole("alert"), "Signing in with the refused details should fail, because no account should exist")
        .toHaveText("Incorrect email or password.");
      await expect(page, "A refused sign-up must not lead to authenticator setup").toHaveURL(/\/fake\/login$/);
    });
  });

  test("an email that already has an account is refused", async ({ page }) => {
    const password = newPassword();

    await test.step("Sign up with the email of an existing account", async () => {
      await page.goto("/signup");
      await submitSignup(page, { name: "QA Synthetic Person", email: config.email, password, confirmPassword: password });
    });

    await test.step("The form says the email is taken and stays on sign-up", async () => {
      await expect(page.getByLabel("Email"), "An email that is already registered should be refused with a clear reason")
        .toHaveAccessibleDescription("An account with this email already exists. Sign in instead.");
      await expect(page, "A refused sign-up should stay on the sign-up page").toHaveURL(/\/signup$/);
    });
  });
});
