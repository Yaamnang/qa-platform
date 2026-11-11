import "server-only";
import type { Job } from "../contract";
import { readRunImage, removeRunScreenshots } from "./run-files";
import { saveJobImage } from "./store";

/**
 * After a console-started Probe run: its problem images go into the store
 * (memory or console_job_images on Supabase), then every screenshot of the run
 * is deleted from disk, whether saving worked or not. The console and the
 * downloaded report read the images from the store only.
 *
 * Never throws. Problems are reported through note(), one plain line each,
 * with no file paths or error details.
 */

const MAX_IMAGES = 20;

export const IMAGES_NOT_SAVED = "[console] Issue images were not saved. Run db/schema-console.sql in the Supabase SQL editor.";
export const IMAGES_NOT_REMOVED = "[console] Some screenshot files of this run could not be deleted from the server.";

export async function moveImagesToStore(jobId: string, result: Job["result"] | undefined, note: (line: string) => void): Promise<void> {
  if (!result?.runId) return;
  try {
    const numbers = [...new Set(result.problems.map((p) => p.image).filter((n): n is number => typeof n === "number"))].slice(0, MAX_IMAGES);
    // Read everything first, so the files can go even if the store is slow or refuses.
    const images = numbers.map((n) => ({ n, image: readRunImage(result.runId, n) }));
    if (!removeRunScreenshots(result.runId)) note(IMAGES_NOT_REMOVED);
    let failed = false;
    for (const { n, image } of images) {
      if (!image) continue;
      try {
        await saveJobImage(jobId, n, image);
      } catch {
        failed = true;
      }
    }
    if (failed) note(IMAGES_NOT_SAVED);
  } catch {
    note(IMAGES_NOT_REMOVED);
  }
}
