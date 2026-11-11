import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./lib/config";

/**
 * Preflight. Runs once before any browser starts.
 *  - Refuses to run against a host that isn't on the allow-list.
 *  - Refuses to run against live unless explicitly allowed and limited to
 *    live-safe tests.
 *  - Checks the platform is up. If it isn't, that's ONE clear "environment
 *    unavailable" result instead of fifteen confusing test failures.
 */
export default async function globalSetup() {
  mkdirSync(config.resultsDir, { recursive: true });
  const host = new URL(config.baseURL).hostname;
  const allowedHosts = (process.env.QA_ALLOWED_HOSTS ?? "localhost,127.0.0.1").split(",").map((h) => h.trim());
  if (!allowedHosts.includes(host)) {
    throw new Error(`SAFETY STOP: ${host} is not in QA_ALLOWED_HOSTS (${allowedHosts.join(", ")}).`);
  }
  if (config.target === "live") {
    if (process.env.QA_ALLOW_LIVE !== "1") {
      throw new Error("SAFETY STOP: QA_TARGET=live requires QA_ALLOW_LIVE=1.");
    }
    if (!/@live-safe/.test(process.env.QA_GREP ?? "")) {
      throw new Error("SAFETY STOP: live runs must be limited to @live-safe tests (set QA_GREP=@live-safe).");
    }
  }

  let lastError = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(new URL("/api/health", config.baseURL), { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        // A deployed copy of the stand-in keeps its AI mode and store at
        // /api/environment instead. A site without it adds nothing.
        const environment = await fetch(new URL("/api/environment", config.baseURL), { signal: AbortSignal.timeout(5000) })
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({}));
        writeFileSync(path.join(config.resultsDir, "environment.json"), JSON.stringify({ ...(await res.json()), ...environment }, null, 2));
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  writeFileSync(path.join(config.resultsDir, "environment-unavailable.txt"), lastError);
  throw new Error(`ENVIRONMENT UNAVAILABLE: ${config.baseURL}/api/health did not respond (${lastError}). No tests were run.`);
}
