/**
 * Every limit of the AI Probe, in one place. Change a number here.
 * Each one makes sure a run always ends, however big the site is.
 */

/** Pages the crawl opens in one run, counting at most two per page pattern (/jobs/:id). */
export const MAX_PAGES = 60;
/** Link hops from the start page (or the signed-in landing page) the crawl follows. */
export const MAX_DEPTH = 8;
/** Seconds the crawl may take before it stops and plans with what it found. */
export const CRAWL_SECONDS = 300;
/** Pages sent to the model in one planning call. Small, so an answer is never cut off. */
export const PAGES_PER_BATCH = 2;
/** Journeys planned for one page: one per distinct action, up to this many. */
export const MAX_JOURNEYS_PER_PAGE = 4;
/** Journeys run in one Probe. */
export const MAX_JOURNEYS = 40;
/** Steps in one journey. */
export const MAX_STEPS_PER_JOURNEY = 8;
/** Steps in one Probe, all journeys together. */
export const MAX_STEPS_TOTAL = MAX_JOURNEYS * MAX_STEPS_PER_JOURNEY;
/** Model tokens (input plus output) one planning run may spend. */
export const MAX_TOKENS = 200_000;
/** Minutes for the whole Probe; journeys not started by then are listed as not run. */
export const MAX_MINUTES = 25;
