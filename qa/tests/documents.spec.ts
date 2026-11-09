import { expect, fixture, qaName, test } from "../lib/test";
import { documentRow, uploadThroughUi } from "../lib/ui";

test.describe("Documents", { tag: ["@documents", "@live-safe"] }, () => {
  test("uploading a CSV adds it to the list with the right row count", async ({ page }) => {
    const name = qaName("upload");
    await page.goto("/workspace");

    await test.step("Choose a CSV file and click Upload", async () => {
      await uploadThroughUi(page, { name, mimeType: "text/csv", buffer: fixture("adverse-events-24.csv") });
    });

    await test.step("The upload is confirmed and the document is listed", async () => {
      await expect(
        page.getByRole("main").getByRole("status"),
        "After clicking Upload, a confirmation should appear (if not, the Upload button may be broken)",
      ).toHaveText(`Uploaded ${name} (24 rows).`);
      const row = documentRow(page, name);
      await expect(row, "The uploaded document should appear in 'Your documents'").toBeVisible();
      await expect(row.getByRole("cell").nth(1), "Row count shown should match the file (24 data rows)").toHaveText("24");
    });

    await test.step("The document is still there after a reload", async () => {
      await page.reload();
      await expect(documentRow(page, name)).toBeVisible();
    });
  });

  test("a non-CSV file is refused with a helpful message", async ({ page, qaApi }) => {
    const before = (await qaApi.listDocuments()).length;
    await page.goto("/workspace");
    await uploadThroughUi(page, { name: qaName("notes", ".txt"), mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.getByRole("main").getByRole("alert"), "Uploading a .txt file should explain why it was refused").toHaveText("Only CSV files can be analysed. Please upload a .csv file.");
    expect((await qaApi.listDocuments()).length, "A refused upload must not create a document").toBe(before);
  });

  test("a CSV with missing columns is refused and names the missing columns", async ({ page }) => {
    await page.goto("/workspace");
    await uploadThroughUi(page, { name: qaName("bad-columns"), mimeType: "text/csv", buffer: fixture("missing-columns.csv") });
    await expect(page.getByRole("main").getByRole("alert"), "Uploading a CSV without the required columns should name what is missing").toHaveText("The file is missing required columns: adverse_event.");
  });

  test("deleting a document removes that document and nothing else", async ({ page, qaApi }) => {
    const keep = await qaApi.seedDocument(qaName("keep"), fixture("adverse-events-24.csv"));
    const remove = await qaApi.seedDocument(qaName("remove"), fixture("adverse-events-24.csv"));
    await page.goto("/workspace");

    await test.step(`Delete "${remove.name}" and confirm`, async () => {
      await page.getByRole("button", { name: `Delete ${remove.name}` }).click();
      const dialog = page.getByRole("dialog", { name: "Delete document?" });
      await expect(dialog).toContainText(remove.name);
      await dialog.getByRole("button", { name: "Delete permanently" }).click();
      await expect(page.getByRole("main").getByRole("status"), "Deleting should confirm which document was deleted").toHaveText(`Deleted ${remove.name}.`);
    });

    await test.step("Only the chosen document is gone, also after a reload", async () => {
      for (const pass of ["on screen", "after reload"]) {
        if (pass === "after reload") await page.reload();
        await expect(documentRow(page, remove.name), `The deleted document should be gone (${pass})`).toHaveCount(0);
        await expect(documentRow(page, keep.name), `The other document must NOT be deleted (${pass})`).toBeVisible();
      }
    });
  });
});
