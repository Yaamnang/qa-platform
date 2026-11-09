import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact, secretsToRedact } from "./redact";
import type { ExploreMap, ProposalSet } from "./types";

/**
 * Phase 3: review and emit.
 *
 * Prints the proposals for a person to read, then writes two files: the raw
 * map, and a draft spec in which every proposed check is `test.skip` with a
 * TODO. Nothing is enabled, nothing lands in `qa/tests/`, and no existing file
 * is ever overwritten. Enabling a check is a person's deliberate act: delete
 * the TODO, implement the steps, move the test into `qa/tests/`.
 *
 * Only the generator decides the shape of the generated code. Model text goes
 * into comments and into one string literal, both escaped, so a surprising
 * answer cannot produce a file that does not compile.
 */

/** One line, and with no sequence that would end a block comment. */
function commentSafe(text: string): string {
  return text.replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\..+/, "");
}

function slug(text: string): string {
  return text.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

/** Never overwrite: if the name is taken, take the next one. */
function freePath(dir: string, base: string, extension: string): string {
  let candidate = path.join(dir, `${base}${extension}`);
  for (let n = 2; existsSync(candidate); n++) candidate = path.join(dir, `${base}-${n}${extension}`);
  return candidate;
}

export function printProposals(set: ProposalSet, log: (line: string) => void): void {
  const secrets = secretsToRedact();
  const line = (text: string) => log(redact(text, secrets));

  line("");
  line(`Proposed checks (${set.proposals.length}) from ${set.source === "mock" ? "the built-in rules, no model" : `${set.source} · ${set.model}`}:`);
  line("");
  set.proposals.forEach((proposal, index) => {
    line(` ${index + 1}. ${proposal.journey}`);
    line(`    area: ${proposal.area} · severity: ${proposal.severity}`);
    line("    steps:");
    proposal.steps.forEach((step, stepIndex) => line(`      ${stepIndex + 1}. ${step}`));
    line("    should be true afterwards:");
    proposal.expectations.forEach((expectation) => line(`      - ${expectation}`));
    line("");
  });
}

function renderDraftSpec(set: ProposalSet, map: ExploreMap, mapFileName: string): string {
  const header = [
    "/**",
    " * DRAFT CHECKS. Nothing in this file runs, and nothing in it has been reviewed.",
    " *",
    ` * Written by \`npm run explore\` against ${commentSafe(map.target)} on ${map.finishedAt}.`,
    ` * Proposed by: ${set.source === "mock" ? "built-in rules (no model)" : `${set.source}, ${commentSafe(set.model)}`}.`,
    ` * Map of what the explorer saw: ${commentSafe(mapFileName)}`,
    " *",
    " * This file sits outside qa/tests/, so the suite never collects it. Every",
    " * check below is skipped on purpose.",
    " *",
    " * To enable one check:",
    " *   1. Read it and decide whether it is worth having at all. Delete the rest.",
    " *   2. Implement the steps with real locators and real assertions.",
    " *   3. Move it into qa/tests/ and change test.skip to test.",
    " */",
    'import { test } from "../lib/test";',
    "",
    'test.describe("Draft checks proposed by the setup agent", { tag: ["@draft"] }, () => {',
  ];

  const body = set.proposals.flatMap((proposal, index) => [
    "  /**",
    `   * ${index + 1}. ${commentSafe(proposal.journey)}`,
    `   * area: ${commentSafe(proposal.area)} · severity: ${proposal.severity}`,
    "   *",
    "   * Steps a user would take:",
    ...proposal.steps.map((step, stepIndex) => `   *   ${stepIndex + 1}. ${commentSafe(step)}`),
    "   *",
    "   * Should be true afterwards:",
    ...proposal.expectations.map((expectation) => `   *   - ${commentSafe(expectation)}`),
    "   *",
    "   * TODO: review this proposal, then implement it or delete it.",
    "   */",
    `  test.skip(${JSON.stringify(proposal.journey)}, async () => {`,
    "    // Proposal only. Implement the steps above before enabling this check.",
    "  });",
    "",
  ]);

  return [...header, "", ...body, "});", ""].join("\n");
}

export type Written = { mapPath: string; specPath: string };

export function writeOutputs(outDir: string, map: ExploreMap, set: ProposalSet): Written {
  const secrets = secretsToRedact();
  mkdirSync(outDir, { recursive: true });

  const base = `explore-${slug(map.target)}-${stamp(map.startedAt)}`;
  const mapPath = freePath(outDir, base, ".map.json");
  writeFileSync(mapPath, redact(JSON.stringify(map, null, 2), secrets) + "\n");

  const specPath = freePath(outDir, base, ".draft.spec.ts");
  writeFileSync(specPath, redact(renderDraftSpec(set, map, path.basename(mapPath)), secrets));

  return { mapPath, specPath };
}

/** One-line count of what the map holds, for the terminal. */
export function describeMap(map: ExploreMap): string {
  const count = (pick: (page: ExploreMap["pages"][number]) => number) => map.pages.reduce((total, page) => total + pick(page), 0);
  return [
    `${map.pages.length} page(s)`,
    `${count((page) => page.forms.length)} form(s)`,
    `${count((page) => page.buttons.length)} button(s)`,
    `${count((page) => page.links.length)} link(s)`,
    `${count((page) => page.tables.length)} table(s)`,
  ].join(" · ");
}
