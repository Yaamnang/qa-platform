import "server-only";
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { JobImage } from "./records";

/**
 * Screenshot files a console-started Probe run left in qa-results/<run id>/.
 * The runner reads the numbered problem images once, puts them in the store,
 * and then deletes every screenshot of that run from disk (job-images.ts).
 *
 * Path rules, for reading and deleting alike:
 *  - the run id must look like one (letters, digits, dash, underscore), and
 *    "latest" and "console" are not runs;
 *  - the run's folder, links followed, must sit directly in qa-results;
 *  - links inside it are never followed, and only plain files are touched.
 */

const RESULTS = path.resolve(process.cwd(), "qa-results");
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NOT_RUNS = new Set(["latest", "console"]);
/** Bigger images are skipped, not imported. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TYPES = [
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
] as const;
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/** The folder of a run, or null when the id or the folder fails the rules above. */
export function runFolder(runId: unknown, root: string = RESULTS): string | null {
  if (typeof runId !== "string" || !RUN_ID.test(runId) || NOT_RUNS.has(runId)) return null;
  const dir = path.join(root, runId);
  try {
    return realpathSync(dir) === path.join(realpathSync(root), runId) ? dir : null;
  } catch {
    return null;
  }
}

const isDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Image n of a run, or null when it is missing, not a plain file, or over the size limit. */
export function readRunImage(runId: unknown, n: number, root: string = RESULTS): JobImage | null {
  const dir = runFolder(runId, root);
  if (!dir || !Number.isInteger(n) || n < 1 || n > 999 || !isDir(path.join(dir, "images"))) return null;
  for (const [ext, mime] of TYPES) {
    const file = path.join(dir, "images", `${n}.${ext}`);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
      return { mime, bytes: readFileSync(file) };
    } catch {
      // Not there: try the other type.
    }
  }
  return null;
}

/** Deletes the image files under dir and its subfolders. Links are not followed. Returns how many could not be deleted. */
function removeImagesUnder(dir: string): number {
  if (!isDir(dir)) return 0;
  let failed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) failed += removeImagesUnder(full);
    else if (entry.isFile() && IMAGE_FILE.test(entry.name)) {
      try {
        rmSync(full, { force: true });
      } catch {
        failed++;
      }
    }
  }
  return failed;
}

/**
 * Deletes every screenshot of a run: its numbered images, the ones Playwright
 * wrote for failed tests (artifacts/) and the copies in its HTML report
 * (html/data/). Traces, summary.json and report.md stay. The same goes for
 * qa-results/latest when it holds this run. Returns false if anything could not be deleted.
 */
export function removeRunScreenshots(runId: unknown, root: string = RESULTS): boolean {
  const dir = runFolder(runId, root);
  if (!dir) return false;
  const folders = [dir];
  const latest = path.join(root, "latest");
  try {
    const summary = JSON.parse(readFileSync(path.join(latest, "summary.json"), "utf8")) as { runId?: unknown };
    if (summary.runId === runId && isDir(latest)) folders.push(latest);
  } catch {
    // No latest copy, or it is another run's.
  }
  let failed = 0;
  for (const folder of folders) {
    for (const sub of ["images", "artifacts", path.join("html", "data")]) {
      try {
        failed += removeImagesUnder(path.join(folder, sub));
      } catch {
        failed++;
      }
    }
  }
  return failed === 0;
}
