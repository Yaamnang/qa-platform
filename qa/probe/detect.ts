/**
 * Which Probe runs. The stand-in in app/ answers GET /api/health with
 * { ok: true, standIn: true, aiMode }. Older stand-in builds have no standIn
 * field but always report aiMode, so that counts too. Anything else, including
 * a site that does not answer, gets the AI Probe.
 *
 * No imports from the app or the console, so both the console server
 * (lib/console/server/probe.ts) and the Probe child can use it.
 */
export async function isStandIn(targetUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/health", targetUrl), { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown; standIn?: unknown; aiMode?: unknown };
    if (body.standIn === true) return true;
    return body.ok === true && typeof body.aiMode === "string" && /^(mock|claude|replay)\b/.test(body.aiMode);
  } catch {
    return false;
  }
}

/** Same check as lib/server/ai.ts and qa/explore/propose.ts. */
export function hasAnthropicKey(): boolean {
  const key = (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  return key.length > 20 && !/change-me|placeholder|your[-_ ]?key|\.\.\./i.test(key);
}

export const NO_KEY_NO_PLAN = "AI Probe needs an Anthropic key or a recorded plan.";
