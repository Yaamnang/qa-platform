import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { redact, secretsToRedact } from "./redact";
import type { ExploreMap, PageMap, Proposal, ProposalSet, TableMap, TokenUsage } from "./types";

/**
 * Phase 2: propose.
 *
 * Same shape as `lib/server/ai.ts`, for the same reasons:
 *
 * mock    (rules mode) proposals derived from the map by this file. No network, no
 *         key, no spend, same output for the same map. This is what CI and a
 *         reviewer on a clean clone get.
 * claude  one real call, then the answer is cached on disk under a hash of
 *         (model, prompt version, map). Running the command again on the same
 *         map replays the recorded answer: identical output, no second charge.
 * replay  cache only. A cache miss fails instead of spending.
 *
 * Which mode runs is decided in run.ts (--ai-mode auto|rules|claude|replay).
 * In claude mode the same model that drove the browser (agent.ts) writes the
 * proposals, Haiku by default, so one setting controls the whole run's cost.
 */

const PROMPT_VERSION = "explore-proposals-v1";
/** One model for the whole explore run: browsing (agent.ts) and proposals. */
export const EXPLORE_MODEL = process.env.EXPLORE_MODEL?.trim() || "claude-haiku-5-5";
const MODEL = EXPLORE_MODEL;
const CACHE_DIR = process.env.EXPLORE_CACHE_DIR ?? path.join(process.cwd(), "qa", ".ai-cache", "explore");

export type AiMode = "mock" | "claude" | "replay";

/** A real-looking key is configured. Placeholders do not count. Same check as lib/server/ai.ts. */
export function hasClaudeCredentials(): boolean {
  const key = (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  return key.length > 20 && !/change-me|placeholder|your[-_ ]?key|\.\.\./i.test(key);
}

export class ProposeError extends Error {}

const ProposalSchema = z.object({
  journey: z.string(),
  area: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  steps: z.array(z.string()),
  expectations: z.array(z.string()),
});

const ResponseSchema = z.object({ proposals: z.array(ProposalSchema) });

const SYSTEM_PROMPT = `You help a QA engineer decide what to check on a web application.

You are given a map of the application, produced by a read-only crawl: the routes it reached, the headings on each page, the forms with their fields, the buttons and links with their accessible names and test ids, the tables with their columns, and the API calls each page made while loading. The crawler never submitted anything, so the map says what exists, not what happens.

Propose candidate end-to-end checks for a person to review. For each one give:
- journey: one line in plain English, what the user is doing.
- area: the part of the product it belongs to, taken from the map.
- severity: critical for sign-in, permissions, tenant separation or data loss; high for a main journey; medium for a secondary flow; low for everything else.
- steps: what a user does, in order, 3 to 8 steps.
- expectations: what must be observably true afterwards, one checkable statement each.

Rules:
- Every check must assert a real outcome: a named row appears in a named table, a downloaded file matches what the screen showed, a number agrees with the source it was computed from, a change survives a reload, a forbidden action is refused with a message.
- Never propose "the page loads", "the heading is visible", or anything about styling, spacing, colour or exact wording. Those checks fail when nothing is broken and teach people to ignore the suite.
- Prefer checks that would catch a bug a user would notice, and that stay quiet when the product is healthy.
- Use only routes, field labels, button names, test ids and column names that appear in the map. Do not invent names.
- Prefer destructive or irreversible journeys only where the map shows they are scoped to data the test created itself.
- Write plainly. No em dashes, no filler, no marketing voice.

Return at most 12 proposals, most valuable first.`;

// ---------------------------------------------------------------------------
// mock: proposals derived from the map, no model involved
// ---------------------------------------------------------------------------

/** "/team" -> "team", "/" -> "workspace". Good enough to group proposals. */
function areaOf(route: string): string {
  const first = route.split("?")[0].split("/").filter(Boolean)[0];
  return first ?? "workspace";
}

/**
 * Which API call a table's rows most likely came from. Matching on a shared
 * word is crude, but a wrong guess only makes one step of a proposal vaguer,
 * and a person is reviewing it anyway.
 */
function likelySource(page: PageMap, table: TableMap): string | null {
  const words = [...page.route.split(/[^a-z0-9]+/i), ...table.name.split(/[^a-z0-9]+/i)]
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 2);
  const related = page.apiCalls.find((call) => words.some((word) => call.toLowerCase().includes(word)));
  // Otherwise the first call that is not a generic session or flags lookup.
  return related ?? page.apiCalls.find((call) => !/\/api\/(me|flags|health)$/.test(call)) ?? null;
}

/**
 * The fake author. It applies four rules a QA engineer would apply by hand, so
 * mock mode produces plausible, deterministic proposals from a real map rather
 * than a canned list. Same map in, same proposals out.
 */
export function mockProposals(map: ExploreMap): Proposal[] {
  const proposals: Proposal[] = [];

  for (const page of map.pages) {
    for (const form of page.forms) {
      if (!form.fields.length || !form.submitLabels.length) continue;
      proposals.push({
        journey: `Submitting "${form.name}" on ${page.route} leaves a result the user can see`,
        area: areaOf(page.route),
        severity: "high",
        steps: [
          `Open ${page.route}`,
          ...form.fields.slice(0, 4).map((field) => `Fill "${field.label}" with a valid value`),
          `Click "${form.submitLabels[0]}"`,
        ],
        expectations: [
          "A confirmation names exactly what was created or changed",
          `The new state appears on ${page.route} without a manual refresh`,
          "It is still there after a reload, so it was really saved",
        ],
      });
    }

    for (const table of page.tables) {
      if (!table.columns.length) continue;
      const source = likelySource(page, table);
      proposals.push({
        journey: `The "${table.name}" table on ${page.route} agrees with the data behind it`,
        area: areaOf(page.route),
        severity: "medium",
        steps: [
          `Open ${page.route}`,
          `Read every row of "${table.name}"`,
          source ? `Read the same records from ${source}` : "Read the same records from their source",
          "Compare them row by row",
        ],
        expectations: [
          `Every row shows the columns ${table.columns.join(", ")}`,
          "Each cell matches the value in the source record, not a rounded or stale copy",
          "No row from outside the signed-in organization appears",
        ],
      });
    }

    for (const link of page.links.filter((candidate) => candidate.kind === "download")) {
      proposals.push({
        journey: `"${link.name}" on ${page.route} downloads a file that matches the screen`,
        area: areaOf(page.route),
        severity: "high",
        steps: [`Open ${page.route}`, `Note the values shown on screen`, `Click "${link.name}"`, "Open the downloaded file"],
        expectations: [
          "The file name identifies the record it belongs to",
          "Every value in the file equals the value shown on screen",
          "The file is not empty and is not an error page saved with the wrong name",
        ],
      });
    }
  }

  // One check per protected route: visiting it without a session must not serve it.
  const protectedRoutes = map.pages.map((page) => page.route).filter((route) => route !== "/" && !/login|signup/.test(route));
  if (protectedRoutes.length) {
    proposals.push({
      journey: "A signed-out visitor cannot reach a signed-in page",
      area: "auth",
      severity: "critical",
      steps: ["Sign out, or start a browser with no session", ...protectedRoutes.slice(0, 4).map((route) => `Open ${route} directly`)],
      expectations: [
        "Each route sends the visitor to the sign-in page",
        "No page shows a name, row or number from the organization behind it before redirecting",
      ],
    });
  }

  return proposals.slice(0, 12);
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/**
 * The exact text the model is given. It is also what the cache is keyed on, so
 * the prompt and the key cannot drift apart.
 *
 * The two timestamps are left out on purpose. They change on every run, and if
 * they were part of the key then "record once, replay many" would never hit:
 * every exploration of an unchanged application would pay for a new answer.
 * Everything that describes the application itself stays in, so a real change
 * to a page does invalidate the entry, which is the point.
 */
function promptInput(map: ExploreMap): string {
  // Listed field by field, so adding something to the map forces a decision
  // here about whether it belongs in the prompt and in the cache key.
  const stable: Omit<ExploreMap, "startedAt" | "finishedAt"> = {
    version: map.version,
    target: map.target,
    limits: map.limits,
    stoppedBecause: map.stoppedBecause,
    signedIn: map.signedIn,
    organization: map.organization,
    pages: map.pages,
    blockedWrites: map.blockedWrites,
    notes: map.notes,
  };
  return redact(JSON.stringify(stable, null, 2), secretsToRedact());
}

function cacheKey(input: string): string {
  return createHash("sha256").update(`${MODEL}\n${PROMPT_VERSION}\n${input}`).digest("hex");
}

async function readCache(key: string): Promise<Proposal[] | null> {
  try {
    const parsed = ResponseSchema.safeParse(JSON.parse(await readFile(path.join(CACHE_DIR, `${key}.json`), "utf8")));
    return parsed.success ? parsed.data.proposals : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, proposals: Proposal[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ proposals }, null, 2));
}

/**
 * Rough size of the proposals request, for the token cap in run.ts. About four
 * characters per token for English and JSON; erring high is fine, since the
 * only effect is falling back to the built-in rules a little early.
 */
export function estimateProposalTokens(map: ExploreMap): number {
  return Math.ceil((SYSTEM_PROMPT.length + promptInput(map).length) / 3.5);
}

async function callClaude(input: string): Promise<{ proposals: Proposal[]; usage: TokenUsage }> {
  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(ResponseSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Map of the application:\n\n${input}` }],
    });
  } catch (error) {
    // Error text from the SDK never contains the key, and nothing here adds it.
    if (error instanceof Anthropic.AuthenticationError) throw new ProposeError("Claude rejected the configured credentials.");
    if (error instanceof Anthropic.RateLimitError) throw new ProposeError("Claude is rate limited. Try again, or use --ai-mode mock.");
    if (error instanceof Anthropic.APIError) throw new ProposeError(`Claude returned an error (${error.status ?? "network"}).`);
    throw new ProposeError("Claude is not reachable right now. Use --ai-mode mock to work offline.");
  }
  if (response.stop_reason === "refusal") throw new ProposeError("Claude declined to answer for this map.");
  const parsed = response.parsed_output;
  if (!parsed) throw new ProposeError("Claude returned a result that did not match the expected shape.");
  return {
    proposals: parsed.proposals,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

export async function proposeChecks(map: ExploreMap, mode: AiMode): Promise<ProposalSet> {
  if (mode === "mock") return { proposals: mockProposals(map), source: "mock", model: "map-rules-v1" };

  const input = promptInput(map);
  const key = cacheKey(input);
  const cached = await readCache(key);
  if (cached) return { proposals: cached, source: "cache", model: MODEL, usage: { input: 0, output: 0 } };
  if (mode === "replay") {
    throw new ProposeError("No recorded proposals for this map (replay mode). Run with --ai-mode claude once to record them.");
  }
  if (!hasClaudeCredentials()) {
    throw new ProposeError("--ai-mode claude needs ANTHROPIC_API_KEY. Use --ai-mode mock to run without a key.");
  }
  const { proposals, usage } = await callClaude(input);
  await writeCache(key, proposals);
  return { proposals, source: "claude", model: MODEL, usage };
}
