/**
 * The two data shapes the setup agent passes between its phases.
 *
 * Phase 1 (explore) produces an ExploreMap: only what the crawler could see on
 * screen or in the DOM. It never holds a value typed into a field, a cookie, a
 * token or an account email, and it records a table's column names but none of
 * its rows, so the file is safe to read, share and paste into a prompt.
 *
 * One limit to know about: the accessible name of a control can contain a
 * record's name, as in a button labelled "Analyze april-events.csv". That is
 * why the explorer runs as the QA account inside the synthetic tenant, and why
 * everything written out goes through `redact.ts` first.
 *
 * Phase 2 (propose) produces Proposals: candidate checks in plain English for a
 * person to approve. Nothing here is a test yet.
 */

export type ExploreMap = {
  /** Bumped when the shape changes, so an old map is never fed to a new prompt. */
  version: 1;
  /** Origin only, for example http://localhost:3100. Never a URL with credentials in it. */
  target: string;
  startedAt: string;
  finishedAt: string;
  /** maxSteps is set only when Claude drove the walk (agent.ts): each step is one model decision. */
  limits: { maxPages: number; maxDepth: number; budgetMs: number; maxSteps?: number };
  /** Why the walk ended. Always set, because the walk always terminates. */
  stoppedBecause: string;
  /** True once the crawler reached a page that is not the sign-in page. */
  signedIn: boolean;
  /** Name of the organization the crawler opened, if the platform asked it to choose one. */
  organization: string | null;
  pages: PageMap[];
  /** Non-GET requests the read-only guard refused. Empty is the expected result. */
  blockedWrites: BlockedWrite[];
  /** Anything the reader of the map should know: redirects, timeouts, skipped links. */
  notes: string[];
};

export type PageMap = {
  /** Path and query as finally reached, after redirects. */
  route: string;
  /**
   * Set only by the AI explorer, for a UI state reached by a click rather than
   * by loading a URL, e.g. 'clicked "Members" (tab)'. The route alone would not
   * say how to get back to it.
   */
  reachedBy?: string;
  /** Route with id-looking segments replaced by ":id", so /jobs/job_1 and /jobs/job_2 group together. */
  template: string;
  depth: number;
  /** Status of the document response, or null if the navigation itself failed. */
  status: number | null;
  title: string;
  headings: Heading[];
  forms: FormMap[];
  buttons: ControlMap[];
  links: LinkMap[];
  tables: TableMap[];
  /** Requests to the platform's own API seen while this page loaded, e.g. "GET /api/documents". */
  apiCalls: string[];
};

export type Heading = { level: number; text: string };

export type FormMap = {
  /** Accessible name of the form, or the nearest heading, or "(unnamed form)". */
  name: string;
  /** The form's action, or a note that the page handles the submit in JavaScript. */
  submitsTo: string;
  method: string;
  fields: FieldMap[];
  /** Labels of the buttons that would submit it. The crawler never clicks them. */
  submitLabels: string[];
};

/** A field's shape only. Never its value: that is how a password stays out of the map. */
export type FieldMap = {
  label: string;
  name: string;
  type: string;
  required: boolean;
  /** Choices of a select, when it has them. */
  options?: string[];
};

export type ControlMap = {
  name: string;
  testId: string | null;
  disabled: boolean;
  /** "submit" means clicking it would send the form it sits in. */
  type: string;
  inFormNamed: string | null;
};

export type LinkMap = {
  name: string;
  href: string;
  testId: string | null;
  kind: "internal" | "external" | "download";
};

export type TableMap = { name: string; columns: string[]; rowCount: number; testId: string | null };

export type BlockedWrite = { method: string; path: string; count: number };

export type Severity = "critical" | "high" | "medium" | "low";

export type Proposal = {
  /** One line, plain English, what the user is doing. */
  journey: string;
  /** Part of the product it belongs to, e.g. documents, team, auth. */
  area: string;
  severity: Severity;
  /** What a person would do, in order. */
  steps: string[];
  /** What must be observably true afterwards. One checkable statement each. */
  expectations: string[];
};

export type ProposalSet = {
  proposals: Proposal[];
  /** Where the proposals came from, printed in the output so nobody has to guess. */
  source: "mock" | "claude" | "cache";
  model: string;
  /** Tokens spent writing these proposals. Absent, or zero, when nothing was sent to a model. */
  usage?: TokenUsage;
};

export type TokenUsage = { input: number; output: number };

/**
 * How the explorer ran, written into the --json-out file next to the
 * proposals. The QA console shows one line from it on the job page.
 */
export type ExplorerSummary = {
  /** rules: the built-in crawler, no model. claude: Claude drove the browser. replay: recorded Claude decisions, no spend. */
  mode: "rules" | "claude" | "replay";
  /** The model id, or "built-in-rules". */
  model: string;
  /** Rules: pages visited. Claude and replay: decisions taken, rejected ones included. */
  steps: number;
  tokens: TokenUsage;
  /** Approximate, from list prices hard-coded in agent.ts. 0 for rules and replay. */
  approxCostUsd: number;
};
