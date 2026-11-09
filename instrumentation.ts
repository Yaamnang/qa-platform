/**
 * Runs once when a Next.js server starts. Starts the console's GitHub poller.
 *
 * Node runtime only: the poller uses node:crypto and the job runner, which the
 * edge runtime does not have. Imported inside the check so the edge bundle
 * never pulls it in. startGithubPoller guards itself, so a second call (a dev
 * reload) does not start a second loop.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startGithubPoller } = await import("./lib/console/server/github-poller");
  startGithubPoller();
}
