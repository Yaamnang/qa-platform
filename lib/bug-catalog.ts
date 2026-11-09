// Shared by the stand-in (server) and the QA orchestrator (bug matrix).
/**
 * Fault injection for the stand-in platform.
 *
 * The QA prototype has to show that it catches different kinds of bugs. Each
 * entry below is a realistic regression that can be switched on at start-up
 * with BUGS=<id>[,<id>...]. The QA suite never reads this list; it has to find
 * the problem the same way it would on the real platform: by using the UI.
 */
export const BUG_CATALOG = {
  "otp-rejects-valid":
    "Sign-in: the one-time-code check rejects every valid code (users locked out).",
  "upload-button-dead":
    "Documents: the Upload button does nothing when clicked (broken button).",
  "delete-wrong-doc":
    "Documents: deleting a document removes a different document.",
  "tenant-leak":
    "Security: the document list forgets the tenant filter and shows other clients' documents.",
  "job-stuck":
    "AI jobs: analysis jobs hang forever at the 'Analyzing' stage.",
  "report-wrong-count":
    "AI jobs: the report states the wrong number of adverse events (off-by-one).",
  "download-mismatch":
    "Downloads: the CSV report drops its last row, so it no longer matches the screen.",
  "settings-not-saved":
    "Settings: 'Saved' confirmation shows but the change is never persisted.",
  "viewer-can-edit":
    "Roles: a Viewer can upload documents (the permission check is skipped).",
  "results-page-crash":
    "AI jobs: the results page throws a JavaScript error when a job finishes.",
  "slow-documents":
    "Performance: the documents list takes 3 seconds to load. Slow but working, so the run must still PASS (no false alarm).",
} as const;

export type BugId = keyof typeof BUG_CATALOG;

/** Injected problems that must NOT fail the run: they prove the absence of false alarms. */
export const MUST_STILL_PASS: BugId[] = ["slow-documents"];
