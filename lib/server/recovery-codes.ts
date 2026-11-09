import "server-only";
import { randomBytes } from "node:crypto";
import { checkPassword, hashPassword } from "./password";

/**
 * Recovery codes: the way back in when the authenticator phone is lost.
 *
 * Shared by the stand-in platform and the QA console so both behave the same.
 *
 * Ten codes are made when an authenticator is set up and shown to the person
 * once. Only hashes are stored, with the same scrypt scheme as passwords, so a
 * database dump does not hand out working codes. Each code works once: the
 * caller deletes the matched hash in the same step that signs the person in.
 *
 * A code is 10 characters from an alphabet with no look-alikes (no 0/O, 1/I/L),
 * shown as two groups of five. That is about 50 bits each, far beyond guessing
 * within the five attempts a sign-in allows.
 */

export const RECOVERY_CODE_COUNT = 10;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function oneCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Strip spaces and dashes and upper-case, so "abcde fghij" matches "ABCDE-FGHIJ". */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Fresh codes to show once, plus the hashes to store. */
export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, oneCode);
  const hashes = codes.map((c) => hashPassword(normalizeRecoveryCode(c)));
  return { codes, hashes };
}

/**
 * Which stored hash this input matches, or -1. The caller removes that hash so
 * the code cannot be used twice. Every hash is checked even after a match, so
 * the time taken does not reveal which position matched.
 */
export function matchRecoveryCode(input: string, hashes: string[]): number {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length !== 10) return -1;
  let found = -1;
  hashes.forEach((h, i) => {
    if (checkPassword(normalized, h) && found === -1) found = i;
  });
  return found;
}
