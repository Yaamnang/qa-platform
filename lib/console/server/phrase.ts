import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { hasClaudeCredentials } from "@/lib/server/ai";
import { EXPLORE_MODEL } from "@/qa/explore/propose";

/**
 * Wording for the run's side of the job chat.
 *
 * The run sends a fixed template ("Signed in.") and a short structured event
 * ("signed-in"). With an Anthropic key configured (the same check as
 * lib/server/ai.ts), Claude Haiku rewrites the template as one short, plain
 * sentence. Without a key, or on any error or slow answer, the template is used
 * as it is. Nothing a run decides depends on this: it only changes wording.
 *
 * What the model sees: the event, the template and the last few chat lines.
 * Never a password, code or authenticator key. Those are not in the chat at
 * all: an answer to a login or code question is recorded only as
 * "Login provided" or "Code provided" (see chat.ts). Kept cheap on purpose:
 * one small request, no history beyond the last few lines, a short limit.
 */

const RECENT_LINES = 4;
const MAX_CHARS = 220;

const SYSTEM = `You write one chat line for an automated QA run that is talking to the QA engineer who started it.
Rewrite the template as one short, plain, first-person sentence. Keep every fact in it (paths, counts, verdicts). Add no facts.
No exclamation marks, no emoji, no em dashes, no greetings, no filler. If it is a question, keep it a clear request.
Reply with the sentence only.`;

let client: Anthropic | null = null;

export async function phrase(kind: "say" | "ask", template: string, event: string | undefined, recent: string[]): Promise<string> {
  if (!hasClaudeCredentials()) return template;
  try {
    client ??= new Anthropic({ timeout: 6000, maxRetries: 0 });
    const context = recent.slice(-RECENT_LINES).map((line) => `- ${line.slice(0, 200)}`).join("\n") || "(none)";
    const response = await client.messages.create({
      model: EXPLORE_MODEL,
      max_tokens: 80,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Kind: ${kind === "ask" ? "question to the engineer" : "progress note"}\nEvent: ${event ?? "note"}\nTemplate: ${template}\n\nLast chat lines:\n${context}`,
        },
      ],
    });
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/!/g, ".")
      .replace(/\u2014|\u2013/g, ",")
      .trim()
      .replace(/^["']|["']$/g, "");
    return text && text.length <= MAX_CHARS ? text : template;
  } catch {
    return template;
  }
}
