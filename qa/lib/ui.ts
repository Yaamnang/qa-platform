import { expect, type Page } from "@playwright/test";
import { liveAction } from "./live-view";

/**
 * User-level actions, written with the locators a person would use
 * (labels, roles, visible text) rather than CSS selectors. When the UI is
 * restyled the tests keep working; when a label disappears, users and
 * screen readers lose it too, so a failure there is a real finding.
 */

export async function submitPassword(page: Page, email: string, password: string) {
  await liveAction(page, "Opening the sign-in page");
  await page.goto("/login");
  const emailField = page.getByLabel("Email");
  await liveAction(page, "Typing the email", emailField);
  await emailField.fill(email);
  // exact: the eye button next to the field is labelled "Show password".
  const passwordField = page.getByLabel("Password", { exact: true });
  await liveAction(page, "Typing the password", passwordField);
  await passwordField.fill(password);
  const continueButton = page.getByRole("button", { name: "Continue" });
  await liveAction(page, "Clicking 'Continue'", continueButton);
  await continueButton.click();
}

export async function submitCode(page: Page, code: string) {
  const codeField = page.getByLabel("Authentication code");
  await expect(codeField, "After a correct password, the sign-in page should ask for a one-time code").toBeVisible();
  await liveAction(page, "Typing the one-time code", codeField);
  await codeField.fill(code);
  const verifyButton = page.getByRole("button", { name: "Verify" });
  await liveAction(page, "Clicking 'Verify'", verifyButton);
  await verifyButton.click();
}

/** After the code: the organization picker. The bot only ever opens its own synthetic organization. */
export async function chooseOrganization(page: Page, name: string) {
  await expect(page, "After a valid one-time code the user should be asked to choose an organization").toHaveURL(/\/orgs$/);
  const openButton = page.getByRole("button", { name: `Open ${name}`, exact: true });
  await liveAction(page, `Opening ${name}`, openButton);
  await openButton.click();
}

export async function expectSignedInWorkspace(page: Page, tenantName: string) {
  await expect(page, "After a valid one-time code the user should land on their workspace").toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: "Documents", exact: true }), "The workspace should show the Documents page").toBeVisible();
  await expect(page.getByTestId("tenant-badge"), "The header should show which workspace the user is in").toHaveText(`Workspace: ${tenantName}`);
}

export async function uploadThroughUi(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const fileInput = page.getByLabel("CSV file");
  await liveAction(page, `Choosing ${file.name}`, fileInput);
  await fileInput.setInputFiles(file);
  const uploadButton = page.getByRole("button", { name: "Upload" });
  await liveAction(page, "Clicking 'Upload'", uploadButton);
  await uploadButton.click();
}

export function documentRow(page: Page, name: string) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
}

/** A member or invite on the team page, found by email. Cells: name, email, role, status. */
export function personRow(page: Page, email: string) {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: email, exact: true }) });
}

export async function inviteThroughUi(page: Page, email: string, role: "Admin" | "Viewer") {
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Role").selectOption({ label: role });
  await page.getByRole("button", { name: "Send invite" }).click();
}
