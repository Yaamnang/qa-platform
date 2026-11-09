import { existsSync, readFileSync, rmSync } from "node:fs";
import { config, QA_PREFIX } from "./lib/config";
import { forgetRunSecrets } from "./lib/console-link";

/**
 * After every run:
 *  - sweep up documents and invites the bot created in earlier runs that
 *    crashed before cleaning up (only names/emails with the QA prefix, only
 *    in the bot's tenant);
 *  - sign the bot's shared session out, so a session token that ended up in
 *    a trace or screenshot is worthless;
 *  - delete the stored session file, and the encrypted login a console run
 *    may have shared between workers (lib/console-link.ts).
 */
export default async function globalTeardown() {
  forgetRunSecrets();
  if (!existsSync(config.storageState)) return;
  const state = JSON.parse(readFileSync(config.storageState, "utf8"));
  const cookie = (state.cookies as { name: string; value: string }[]).map((c) => `${c.name}=${c.value}`).join("; ");
  const call = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, config.baseURL), { ...init, headers: { cookie, ...(init.headers ?? {}) } });

  try {
    const me = await (await call("/api/me")).json();
    if (me?.tenant?.slug === config.expectedTenant) {
      const { documents = [] } = await (await call("/api/documents")).json();
      for (const d of documents as { id: string; name: string }[]) {
        if (d.name.startsWith(QA_PREFIX)) await call(`/api/documents/${d.id}`, { method: "DELETE" });
      }
      const { invites = [] } = await (await call("/api/team")).json();
      for (const i of invites as { id: string; email: string }[]) {
        if (i.email.startsWith(QA_PREFIX)) await call(`/api/team/invites/${i.id}`, { method: "DELETE" });
      }
    }
    await call("/api/auth/logout", { method: "POST" });
  } catch {
    // Teardown problems must never turn a green run red.
  } finally {
    rmSync(config.storageState, { force: true });
  }
}
