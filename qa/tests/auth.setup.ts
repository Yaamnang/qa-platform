import { mkdirSync } from "node:fs";
import { config } from "../lib/config";
import { askLogin, askTimeoutMs, linked, rememberForRun } from "../lib/console-link";
import { freshCode } from "../lib/totp";
import { expect, test } from "../lib/test";
import { chooseOrganization, expectSignedInWorkspace, submitCode, submitPassword } from "../lib/ui";

// Traces record typed values, so never trace the steps that type secrets.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("sign in as the QA bot with password + one-time code", { tag: ["@auth", "@live-safe"] }, async ({ page }) => {
  // Started from the QA console without a saved login: the run asks the
  // employee in the job's chat at each screen instead (qa/lib/console-link.ts).
  // With the variables set (npm run qa, CI, the bug matrix) nothing below changes.
  const askInConsole = linked() && (!config.password || !config.totpSecret);
  test.skip(!askInConsole && (!config.password || !config.totpSecret), "QA_PASSWORD / QA_TOTP_SECRET not provided");
  if (askInConsole) test.setTimeout(2 * askTimeoutMs() + 120_000);

  await test.step("Enter email and password", async () => {
    if (!config.password) {
      await page.goto("/login");
      await page.getByLabel("Email").waitFor();
      const login = await askLogin(`The sign-in page at ${new URL(page.url()).host} is asking for the QA account's email and password.`);
      // Shared with the later test workers of this run, encrypted. Never logged.
      rememberForRun(login);
    }
    await submitPassword(page, config.email, config.password);
  });

  await test.step("Enter the one-time code from the authenticator secret", async () => {
    // Without a key, ask only once the code screen is really there. If it never
    // comes (wrong password), submitCode below fails with its own clear message.
    const codeField = page.getByLabel("Authentication code");
    if (!config.totpSecret) await codeField.waitFor({ timeout: 15_000 }).catch(() => undefined);
    const code = !config.totpSecret && !(await codeField.isVisible()) ? "" : await freshCode();
    await submitCode(page, code);
    const shownError = page.getByRole("main").getByRole("alert");
    await expect(page, "A valid one-time code should take the bot to the organization picker")
      .toHaveURL(/\/orgs$/)
      .catch(async (e) => {
        if (await shownError.count()) throw new Error(`Sign-in with a valid one-time code was refused: "${await shownError.innerText()}"`);
        throw e;
      });
  });

  await test.step("Check the bot belongs to its own synthetic organization only (safety stop)", async () => {
    // Least privilege: the bot account must be a member of exactly one
    // organization, the synthetic QA one. Anything else stops the run.
    const res = await page.request.get("/api/orgs");
    expect(res.ok(), `SAFETY STOP: could not list the QA bot's organizations (GET /api/orgs returned ${res.status()}). No tests were run.`).toBe(true);
    const { organizations } = (await res.json()) as { organizations: { slug: string; name: string }[] };
    const slugs = organizations.map((o) => o.slug);
    expect(
      slugs,
      `SAFETY STOP: the QA bot can open organizations [${slugs.join(", ")}], expected only "${config.expectedTenant}". No tests were run.`,
    ).toEqual([config.expectedTenant]);
    await chooseOrganization(page, organizations[0].name);
  });

  await test.step("Confirm the bot is inside its own synthetic tenant (safety stop)", async () => {
    // Fail closed: if we can't prove the bot is in its own synthetic tenant,
    // stop the whole run before any test can click anything.
    await expect(page, "Opening the QA organization should land on its workspace").toHaveURL(/\/workspace$/);
    const res = await page.request.get("/api/me");
    expect(res.ok(), `SAFETY STOP: could not confirm which tenant the QA bot is in (GET /api/me returned ${res.status()}). No tests were run.`).toBe(true);
    const me = await res.json();
    expect(
      me.tenant?.slug,
      `SAFETY STOP: the QA bot signed in to tenant "${me.tenant?.slug}", expected "${config.expectedTenant}". No tests were run.`,
    ).toBe(config.expectedTenant);
    await expectSignedInWorkspace(page, me.tenant.name);
  });

  mkdirSync(config.authDir, { recursive: true });
  await page.context().storageState({ path: config.storageState });
});
