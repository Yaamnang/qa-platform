import "server-only";
import { BUG_CATALOG, type BugId } from "../bug-catalog";

export { BUG_CATALOG, type BugId };

export function enabledBugs(): BugId[] {
  return (process.env.BUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is BugId => s in BUG_CATALOG);
}

export function bug(id: BugId): boolean {
  return enabledBugs().includes(id);
}

/** Bugs that live in client components; served to the browser via /api/flags. */
export const CLIENT_BUGS: BugId[] = ["upload-button-dead", "results-page-crash"];
