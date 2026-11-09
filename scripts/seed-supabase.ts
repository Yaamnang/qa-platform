/**
 * Reset and seed the Supabase database for the stand-in platform.
 *
 *   npm run db:seed
 *
 * Mirrors seed() in lib/server/store.ts exactly: the same tenant ids, the same
 * fictional users, the same three documents including the canary. Tenant ids
 * are fixed on purpose so the two backends agree on who owns what.
 *
 * Every row is wiped first, via the eclypse_reset() function in db/schema.sql.
 * The runner calls this before a run so persistent state cannot carry between
 * runs and break the ten-identical-results proof.
 *
 * Client credentials are random and are thrown away as soon as the row is
 * written: nobody, the QA bot included, can sign in as a client.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { hashPassword } from "../lib/server/password";
import { randomBase32Secret } from "../lib/server/totp";
import { CANARY_DOC_ID, QA_TENANT_SLUG } from "../lib/server/store-types";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set. Put them in .env.local.");
  process.exit(2);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

/** Throws with the Postgres message and nothing else, so no credential can leak into a log. */
function check(step: string, error: { message: string } | null) {
  if (error) throw new Error(`${step}: ${error.message}`);
}

const UPLOADED_AT = Date.UTC(2026, 9, 1, 9, 0, 0);
const header = ["subject_id", "arm", "age", "adverse_event", "severity"];

async function main() {
  console.log("• Wiping every eclypse_ table");
  check("reset", (await sb.rpc("eclypse_reset")).error);

  console.log("• Tenants");
  const tenants = [
    { id: "t_acme", slug: "acme-pharma", name: "Acme Pharma" },
    { id: "t_northwind", slug: "northwind-health", name: "Northwind Health" },
    { id: "t_qa", slug: QA_TENANT_SLUG, name: "QA Synthetic" },
    { id: "t_qa_canary", slug: "qa-canary", name: "QA Canary" },
  ];
  check("tenants", (await sb.from("eclypse_tenants").insert(tenants)).error);

  const addUser = async (
    tenantId: string,
    email: string,
    password: string,
    totpSecret: string,
    role: "admin" | "viewer" = "admin",
    displayName?: string,
  ) => {
    const id = `u_${randomUUID().slice(0, 8)}`;
    check(
      `user ${email}`,
      (
        await sb.from("eclypse_users").insert({
          id,
          email,
          password_hash: hashPassword(password),
          totp_secret: totpSecret,
          totp_confirmed: true,
          last_totp_step: -1,
          display_name: displayName ?? email.split("@")[0],
          notification_email: email,
        })
      ).error,
    );
    check(
      `membership ${email}`,
      (await sb.from("eclypse_memberships").insert({ user_id: id, tenant_id: tenantId, role })).error,
    );
    return id;
  };

  console.log("• Client users (random credentials, discarded immediately)");
  const acmeUser = await addUser("t_acme", "j.doe@acme-pharma.example", randomUUID(), randomBase32Secret());
  const nwUser = await addUser("t_northwind", "r.lee@northwind-health.example", randomUUID(), randomBase32Secret());
  const canaryUser = await addUser("t_qa_canary", "qa-canary@synthetic.eclypse.test", randomUUID(), randomBase32Secret());

  // The QA bot exists only when its credentials come from the environment.
  // No default credentials are built in.
  const qaPassword = process.env.SEED_QA_PASSWORD;
  const qaTotp = process.env.SEED_QA_TOTP_SECRET;
  if (qaPassword && qaTotp) {
    await addUser("t_qa", process.env.SEED_QA_EMAIL ?? "qa-bot@synthetic.eclypse.test", qaPassword, qaTotp, "admin", "QA Bot");
    console.log("• QA bot seeded");
  } else {
    console.log("• QA bot skipped (SEED_QA_PASSWORD / SEED_QA_TOTP_SECRET not set)");
  }

  const viewerPassword = process.env.SEED_QA_VIEWER_PASSWORD;
  const viewerTotp = process.env.SEED_QA_VIEWER_TOTP_SECRET;
  if (viewerPassword && viewerTotp) {
    const email = process.env.SEED_QA_VIEWER_EMAIL ?? "qa-viewer@synthetic.eclypse.test";
    await addUser("t_qa", email, viewerPassword, viewerTotp, "viewer", "QA Viewer");
    console.log("• QA viewer seeded");
  }

  console.log("• Documents");
  const doc = (id: string, tenantId: string, name: string, uploadedBy: string, rows: string[][]) => ({
    id,
    tenant_id: tenantId,
    name,
    size_bytes: rows.length * 40,
    table_json: { header, rows },
    uploaded_at: UPLOADED_AT,
    uploaded_by: uploadedBy,
  });
  check(
    "documents",
    (
      await sb.from("eclypse_documents").insert([
        doc("doc_acme_0001", "t_acme", "PH2-ONC-114 interim AE listing.csv", acmeUser, [
          ["ONC-001", "treatment", "61", "neutropenia", "severe"],
          ["ONC-002", "placebo", "58", "fatigue", "mild"],
        ]),
        doc("doc_nw_0001", "t_northwind", "NW-CARD-07 safety listing.csv", nwUser, [
          ["CARD-01", "treatment", "70", "dizziness", "moderate"],
        ]),
        // Canary: lives in a second synthetic tenant the QA team owns. If the
        // QA bot ever sees this marker, tenant isolation is broken.
        doc(CANARY_DOC_ID, "t_qa_canary", "QA-CANARY-7f3a2c do-not-display.csv", canaryUser, [
          ["QA-CANARY-7f3a2c", "placebo", "40", "canary", "mild"],
        ]),
      ])
    ).error,
  );

  console.log("\nSeeded: 4 tenants, 3 documents, and the users above.");
}

main().catch((err: unknown) => {
  console.error(`Seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
