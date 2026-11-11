import { config, secretValues } from "../lib/config";
import { linkSecrets } from "../lib/console-link";
import { codesSince } from "../lib/totp";

/**
 * Last line of defence for secrets.
 *
 * The explorer never reads a field value and never prints its credentials, so
 * in theory nothing secret can reach the map, the prompt or the terminal. This
 * runs anyway, over every string the command writes or sends, because "in
 * theory" is not a guarantee and a leaked secret in a committed draft file
 * cannot be taken back.
 */

/**
 * Known credentials (a QA password, an authenticator key, a login or code from
 * the console's chat, a one-time code the run typed) are cut whatever their
 * length, down to this floor. A value of one or two characters is left alone:
 * cutting every "ab" would shred ordinary text, and no real login is that short.
 */
const MIN_CREDENTIAL_LENGTH = 3;
/** Generic environment secrets (API keys) are long. A shorter value is a placeholder, not a key. */
const MIN_ENV_SECRET_LENGTH = 6;

/** The one rule for building a redaction list: the floors above, no duplicates, longest first so overlaps are replaced whole. */
export function redactionList(credentials: unknown[], envSecrets: unknown[] = []): string[] {
  const atLeast = (min: number) => (value: unknown): value is string => typeof value === "string" && value.trim().length >= min;
  return [...new Set([...credentials.filter(atLeast(MIN_CREDENTIAL_LENGTH)), ...envSecrets.filter(atLeast(MIN_ENV_SECRET_LENGTH))])].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * Every value that must never appear in output. extraCredentials: a run's own
 * login (the explorer's and the probe's), which may not be in the environment.
 */
export function secretsToRedact(extraCredentials: unknown[] = []): string[] {
  const env = process.env;
  const totpSecrets = [config.totpSecret, config.viewer.totpSecret, env.SEED_QA_TOTP_SECRET, env.SEED_QA_VIEWER_TOTP_SECRET];
  const startedAt = Date.now() - process.uptime() * 1000;
  const credentials = [
    ...secretValues(),
    env.SEED_QA_PASSWORD,
    env.SEED_QA_VIEWER_PASSWORD,
    ...totpSecrets,
    // A login, code or key from the QA console's chat, and every code this process typed.
    ...linkSecrets(),
    // Codes another process of this run may have typed (a Playwright worker, seen from the reporter).
    ...totpSecrets.flatMap((secret) => (secret ? codesSince(secret, startedAt) : [])),
    ...extraCredentials,
  ];
  return redactionList(credentials, [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.SUPABASE_SECRET_KEY]);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}
