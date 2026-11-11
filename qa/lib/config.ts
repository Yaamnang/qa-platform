import path from "node:path";
import { runSecret } from "./console-link";

/**
 * All QA configuration comes from the environment. In CI the secrets come from
 * the CI secret store; for local runs `qa/run.ts` generates throw-away
 * credentials for the stand-in on every run. Nothing secret lives in the repo.
 */
const env = process.env;
/** Repo root. QA commands always run from here (npm scripts). */
export const ROOT = process.cwd();

/** local: started by qa/run.ts. stand-in: a deployed test copy of the platform. */
export type Target = "local" | "stand-in" | "staging" | "live";

export const config = {
  baseURL: env.QA_BASE_URL ?? "http://localhost:3100",
  target: (env.QA_TARGET ?? "local") as Target,
  runId: env.QA_RUN_ID ?? "adhoc",

  // Getters, so a login the employee typed into the QA console's job chat
  // during this run (see console-link.ts) is seen by every later test too.
  // Without the console these read exactly the variables, as before.
  get email(): string {
    return runSecret("email") ?? env.QA_EMAIL ?? "qa-bot@synthetic.eclypse.test";
  },
  get password(): string {
    return env.QA_PASSWORD || runSecret("password") || "";
  },
  get totpSecret(): string {
    return env.QA_TOTP_SECRET || runSecret("totpSecret") || "";
  },

  /** Second QA account: a read-only Viewer in the same QA org, used by the role tests. */
  viewer: {
    email: env.QA_VIEWER_EMAIL || "qa-viewer@synthetic.eclypse.test",
    password: env.QA_VIEWER_PASSWORD ?? "",
    totpSecret: env.QA_VIEWER_TOTP_SECRET ?? "",
  },

  /**
   * The target's sign-in page. /fake/login is the stand-in embedded in this
   * repo. QA_SIGNIN_PATH overrides it; qa/run.ts sets it from the target's
   * /api/health (signInPath) when testing a deployed copy.
   */
  signInPath: env.QA_SIGNIN_PATH?.startsWith("/") ? env.QA_SIGNIN_PATH : "/fake/login",

  /** The only tenant the bot may ever operate in. Checked after every sign-in. */
  expectedTenant: env.QA_EXPECTED_TENANT ?? "qa-synthetic",
  /** Markers planted in a second synthetic tenant. Seeing one = isolation breach. */
  canaryMarkers: (env.QA_CANARY_MARKERS ?? "QA-CANARY-7f3a2c").split(",").map((s) => s.trim()).filter(Boolean),
  canaryDocId: env.QA_CANARY_DOC_ID ?? "doc_qacanary_0001",

  /** Long AI jobs: give up after this long overall... */
  jobTimeoutMs: Number(env.QA_JOB_TIMEOUT_MS ?? 120_000),
  /** ...or sooner if nothing on screen changes for this long. */
  jobStallMs: Number(env.QA_JOB_STALL_MS ?? 15_000),

  resultsDir: path.resolve(ROOT, env.QA_RESULTS_DIR ?? path.join("qa-results", "adhoc")),
  authDir: path.join(ROOT, "qa", ".auth"),
  storageState: path.join(ROOT, "qa", ".auth", "state.json"),
};

/** Sign-up creates accounts that cannot be deleted, so only on a stand-in, local or deployed. */
export const signUpAllowed = config.target === "local" || config.target === "stand-in";

/** Matches a URL that is the sign-in page, for "sent to sign-in" checks. */
export const signInUrl = new RegExp(config.signInPath.replace(/[.*+?^$|()[\]{}\\]/g, "\\$&") + "$");

/** Prefix for everything the bot creates, so it can find and clean up only its own data. */
export const QA_PREFIX = "qa-run-";

/** The QA accounts' credentials. Redaction (qa/explore/redact.ts) decides the length floor. */
export function secretValues(): string[] {
  return [config.password, config.totpSecret, config.viewer.password, config.viewer.totpSecret].filter((s) => s.length > 0);
}
