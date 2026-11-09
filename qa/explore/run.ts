/**
 * The setup agent: explore a deployment, propose checks, write a draft.
 *
 *   npm run explore                                  explore the local stand-in on :3100
 *   npm run explore -- --target https://staging.example.com
 *   npm run explore -- --ai-mode auto                the default: claude if ANTHROPIC_API_KEY is set, else rules
 *   npm run explore -- --ai-mode rules               built-in crawler and proposal rules, no model, no spend
 *   npm run explore -- --ai-mode claude              Claude drives the browser and writes the proposals (costs money, cached)
 *   npm run explore -- --ai-mode replay              re-run recorded Claude decisions and proposals, no network
 *   npm run explore -- --max-pages 10 --budget-ms 30000
 *   npm run explore -- --json-out out.json           also write the proposals as JSON (the QA console reads this)
 *
 * The explorer starts at the target URL as a signed-out visitor and maps what
 * a visitor can see. It signs in only if it reaches a sign-in screen (a
 * visible password field), at most once. Credentials come from the same
 * variables the runner uses: QA_EMAIL, QA_PASSWORD, QA_TOTP_SECRET. Against
 * the local stand-in the same account is seeded from SEED_QA_*, so those are
 * used as a fallback. With none of them, a run from the QA console asks in
 * the job's chat, and a plain run notes the sign-in screen and skips it.
 *
 * Nothing this command writes is active. It never writes into qa/tests/, never
 * overwrites a file, and every proposed check is skipped until a person
 * enables it.
 *
 * In claude mode the model chooses where to go, but only inside the same
 * read-only browser as the rules crawler: see agent.ts for why that keeps it
 * safe. Model and limits come from EXPLORE_MODEL (default claude-haiku-5-5),
 * EXPLORE_MAX_STEPS (default 20) and EXPLORE_MAX_TOKENS (default 200000).
 * Probe (qa/run.ts) is a different command and never uses a model to decide
 * anything.
 *
 * Exit code: 0 = done (also when sign-in was skipped or refused: that is a
 * note, and the public pages are still mapped), 2 = the target did not load
 * at all, 3 = command error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, ROOT } from "../lib/config";
import { linked, say } from "../lib/console-link";
import { AgentError, approxCostUsd, exploreWithClaude } from "./agent";
import { explore, ExploreUnavailable, type Credentials } from "./crawl";
import { describeMap, printProposals, writeOutputs } from "./emit";
import { estimateProposalTokens, EXPLORE_MODEL, hasClaudeCredentials, proposeChecks, type AiMode } from "./propose";
import { redact, secretsToRedact } from "./redact";
import type { ExploreMap, ExplorerSummary, ProposalSet, TokenUsage } from "./types";

const { values: args } = parseArgs({
  options: {
    target: { type: "string" },
    "base-url": { type: "string" }, // alias of --target, same as qa/run.ts
    "ai-mode": { type: "string" },
    "max-pages": { type: "string", default: "25" },
    "max-depth": { type: "string", default: "3" },
    "budget-ms": { type: "string", default: "120000" },
    out: { type: "string", default: path.join("qa", "drafts") },
    "json-out": { type: "string" },
    headed: { type: "boolean", default: false },
  },
});

const log = (line = "") => process.stdout.write(`${line}\n`);

function credentials(): Credentials {
  // config.email / .password / .totpSecret are the runner's variables. The
  // SEED_QA_* fallback is the same account on the local stand-in, which the
  // platform seeds from those variables at startup.
  return {
    email: process.env.QA_EMAIL ?? process.env.SEED_QA_EMAIL ?? config.email,
    password: process.env.QA_PASSWORD || (process.env.SEED_QA_PASSWORD ?? ""),
    totpSecret: process.env.QA_TOTP_SECRET || (process.env.SEED_QA_TOTP_SECRET ?? ""),
  };
}

function positive(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number.`);
  return parsed;
}

/** A positive whole number from the environment, or the default when the variable is blank. */
function fromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive whole number.`);
  return parsed;
}

type ExploreMode = ExplorerSummary["mode"];

/**
 * auto (the default) means claude when a real-looking ANTHROPIC_API_KEY is
 * configured, and the built-in rules otherwise, so a clean clone with no key
 * still works and costs nothing. "mock" is accepted as the old name for
 * rules. Anything unrecognised also means rules, so a typo can never start
 * spending.
 */
function resolveMode(flag: string | undefined): { mode: ExploreMode; note: string | null } {
  const raw = (flag ?? process.env.EXPLORE_AI_MODE ?? "auto").trim();
  if (raw === "claude" || raw === "replay" || raw === "rules") return { mode: raw, note: null };
  if (raw === "mock") return { mode: "rules", note: null };
  if (raw === "auto") {
    return hasClaudeCredentials()
      ? { mode: "claude", note: "auto: an Anthropic key is configured, so Claude drives the exploration." }
      : { mode: "rules", note: "auto: no Anthropic key is configured, so the built-in rules explore." };
  }
  return { mode: "rules", note: `Unknown --ai-mode "${raw}", so the built-in rules explore.` };
}

const add = (a: TokenUsage, b: TokenUsage | undefined): TokenUsage => ({ input: a.input + (b?.input ?? 0), output: a.output + (b?.output ?? 0) });

async function main(): Promise<number> {
  const target = args.target ?? args["base-url"] ?? config.baseURL;
  let origin: string;
  let start: string;
  try {
    const url = new URL(target);
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocol");
    origin = url.origin;
    start = url.pathname + url.search;
  } catch {
    log(`--target must be an http or https URL. Got: ${target}`);
    return 3;
  }

  // Same opt-in guard as the runner's preflight: when an allow-list is
  // configured, a host that is not on it stops the command. Unlike the runner
  // there is no default allow-list, because pointing this at a URL it has
  // never seen is the whole point. What makes that safe is the read-only
  // guard, not a list.
  const allowed = (process.env.QA_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  const host = new URL(origin).hostname;
  if (allowed.length && !allowed.includes(host)) {
    log(`SAFETY STOP: ${host} is not in QA_ALLOWED_HOSTS (${allowed.join(", ")}). Nothing was explored.`);
    return 2;
  }

  // --json-out keeps the same two promises as the draft: nothing written into
  // qa/tests/, and no existing file overwritten (the "wx" flag below).
  const jsonOut = args["json-out"] ? path.resolve(ROOT, args["json-out"]) : null;
  if (jsonOut && jsonOut.startsWith(path.join(ROOT, "qa", "tests") + path.sep)) {
    log("--json-out must not point into qa/tests/.");
    return 3;
  }

  const creds = credentials();
  if (!creds.password) {
    // Not an error: most of a site is public. The sign-in gate (crawl.ts) decides what to do if a sign-in screen is reached.
    log(
      linked()
        ? "• No saved QA login for this target. If the explorer reaches a sign-in screen it asks in the console, and you can skip it."
        : "• No saved QA login for this target. Public pages only; a sign-in screen, if reached, is noted and skipped.",
    );
  }

  const { mode, note: modeNote } = resolveMode(args["ai-mode"]);
  // Asked for by name, so a missing key is an error rather than a quiet switch to the rules.
  if (mode === "claude" && !hasClaudeCredentials()) {
    log("--ai-mode claude needs ANTHROPIC_API_KEY. Use --ai-mode rules (or auto) to run without a key.");
    return 3;
  }
  const maxPages = positive(args["max-pages"], "max-pages");
  const maxDepth = positive(args["max-depth"], "max-depth");
  const budgetMs = positive(args["budget-ms"], "budget-ms");
  const maxSteps = fromEnv("EXPLORE_MAX_STEPS", 20);
  const maxTokens = fromEnv("EXPLORE_MAX_TOKENS", 200_000);
  const usesModel = mode !== "rules";

  log(`Setup agent · target ${origin} · mode ${mode}${usesModel ? ` · model ${EXPLORE_MODEL}` : ""}`);
  if (modeNote) log(modeNote);
  log("Exploration is read-only: every request that is not a GET is aborted in the browser, apart from the sign-in form if one is reached.");
  log("");

  const crawlOptions = { origin, start, credentials: creds, maxPages, maxDepth, budgetMs, headed: args.headed!, log };
  let map: ExploreMap;
  let steps: number;
  let usage: TokenUsage = { input: 0, output: 0 };
  // Set when the walk already spent its share or Claude already failed: then
  // the proposals come from the rules, and the output says so.
  let skipModelForProposals: string | null = null;
  if (usesModel) {
    const result = await exploreWithClaude({ ...crawlOptions, mode: mode === "replay" ? "replay" : "claude", maxSteps, maxTokens });
    map = result.map;
    steps = result.steps;
    usage = result.usage;
    if (result.tokenCapHit) skipModelForProposals = `the token cap of ${maxTokens} was reached while exploring`;
    else if (result.modelFailed) skipModelForProposals = `Claude failed during exploration (${map.stoppedBecause})`;
  } else {
    map = await explore(crawlOptions);
    steps = map.pages.length;
  }
  log("");
  log(`Explored ${describeMap(map)}. Stopped because ${map.stoppedBecause}.`);
  if (map.blockedWrites.length) {
    log("Write attempts refused by the read-only guard:");
    for (const blocked of map.blockedWrites) log(`  ${blocked.method} ${blocked.path} (${blocked.count}x)`);
  } else {
    log("No write was attempted, so none had to be refused.");
  }
  for (const note of map.notes) log(`  note: ${note}`);

  // The proposals request is checked against the cap before it is sent, so
  // the cap holds for the whole run and not just the walk.
  if (mode === "claude" && !skipModelForProposals && usage.input + usage.output + estimateProposalTokens(map) > maxTokens) {
    skipModelForProposals = `writing proposals would pass the token cap of ${maxTokens}`;
  }
  const proposeMode: AiMode = mode === "rules" || skipModelForProposals ? "mock" : mode;

  log("");
  if (skipModelForProposals) log(`• Proposing checks with the built-in rules, because ${skipModelForProposals}. Everything mapped so far is kept.`);
  else log(proposeMode === "mock" ? "• Proposing checks from the map (built-in rules, no model, no spend)…" : `• Asking ${EXPLORE_MODEL} for candidate checks…`);
  const proposals: ProposalSet = await proposeChecks(map, proposeMode);
  printProposals(proposals, log);
  usage = add(usage, proposals.usage);

  const explorer: ExplorerSummary = {
    mode,
    model: usesModel ? EXPLORE_MODEL : "built-in-rules",
    steps,
    tokens: usage,
    // Replay never calls the network, so it never costs anything.
    approxCostUsd: mode === "claude" ? Number(approxCostUsd(usage).toFixed(4)) : 0,
  };
  // One line, always, so the cost of a run is never a guess.
  log(
    `Explorer: mode ${explorer.mode} · model ${explorer.model} · ${steps} steps · ` +
      `${usage.input} input / ${usage.output} output tokens · about $${explorer.approxCostUsd.toFixed(3)} (approximate rates)`,
  );

  await say(
    `Done. I mapped ${describeMap(map)} and proposed ${proposals.proposals.length} checks for you to review. Nothing is active until you approve it.`,
    "done",
  );

  const written = writeOutputs(path.resolve(ROOT, args.out!), map, proposals);
  log(`Map:   ${path.relative(ROOT, written.mapPath)}`);
  log(`Draft: ${path.relative(ROOT, written.specPath)}`);
  if (jsonOut) {
    mkdirSync(path.dirname(jsonOut), { recursive: true });
    // { explorer, proposals }: the QA console reads both. It also still accepts
    // the older shape, a bare proposals array.
    const payload = { explorer, proposals: proposals.proposals };
    writeFileSync(jsonOut, redact(JSON.stringify(payload, null, 2), secretsToRedact()) + "\n", { flag: "wx" });
    log(`JSON:  ${path.relative(ROOT, jsonOut)}`);
  }
  log("");
  log("NOTHING IS ACTIVE. Every proposed check is written as test.skip with a TODO, outside qa/tests/,");
  log("so the suite does not collect it. A person has to review a check, implement it and enable it.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    // Redacted, because an error message is still output.
    const message = redact(error.message, secretsToRedact());
    if (error instanceof AgentError) {
      console.error(`Setup agent stopped: ${message}`);
      process.exit(3);
    }
    if (error instanceof ExploreUnavailable) {
      console.error(`ENVIRONMENT UNAVAILABLE: ${message}`);
      process.exit(2);
    }
    console.error(`Setup agent error: ${message}`);
    process.exit(3);
  },
);
