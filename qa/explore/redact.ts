import { secretValues } from "../lib/config";
import { linkSecrets } from "../lib/console-link";

/**
 * Last line of defence for secrets.
 *
 * The explorer never reads a field value and never prints its credentials, so
 * in theory nothing secret can reach the map, the prompt or the terminal. This
 * runs anyway, over every string the command writes or sends, because "in
 * theory" is not a guarantee and a leaked secret in a committed draft file
 * cannot be taken back.
 */

/** Every value that must never appear in output, longest first so overlaps are replaced whole. */
export function secretsToRedact(): string[] {
  const fromEnv = [
    process.env.SEED_QA_PASSWORD,
    process.env.SEED_QA_TOTP_SECRET,
    process.env.SEED_QA_VIEWER_PASSWORD,
    process.env.SEED_QA_VIEWER_TOTP_SECRET,
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.SUPABASE_SECRET_KEY,
  ];
  // linkSecrets: a login or code the employee gave this process through the QA console's chat.
  return [...secretValues(), ...fromEnv, ...linkSecrets()]
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 6)
    .sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}
