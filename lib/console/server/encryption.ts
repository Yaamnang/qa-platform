import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isSupabaseEnabled } from "@/lib/server/auth-store";

/**
 * Encryption at rest for the QA account a project signs in with: its password
 * and its TOTP secret.
 *
 * This is the honest demo version. In production these two values would live
 * in a secrets manager (AWS Secrets Manager, Vault, or similar) and the
 * console_projects row would hold only a reference to them. A database dump
 * would then contain nothing usable, and every read of a secret would be
 * logged by the manager.
 *
 * AES-256-GCM with the key from CONSOLE_SECRET_KEY (32 bytes, base64). Every
 * value gets its own random 12-byte IV, so the same password stored twice
 * gives two different ciphertexts. GCM also produces a 16-byte auth tag, which
 * is stored and checked on the way out: a ciphertext that was altered in the
 * database fails to decrypt instead of decrypting to something wrong.
 *
 * Stored format: "v1:<iv>:<tag>:<ciphertext>", each part base64. The version
 * lets the format change later without guessing what an old value is.
 *
 * Error messages name the variable and never contain a value.
 */

/** Thrown when the key is missing or wrong. Routes turn it into a 500 with this message. */
export class ConsoleKeyError extends Error {}

const GENERATE_HINT =
  "Set it to 32 random bytes, base64-encoded: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";

/**
 * Read when needed, not at import: a console without the key still starts,
 * and only the actions that store or use a credential fail, with this message.
 */
function key(): Buffer {
  const raw = process.env.CONSOLE_SECRET_KEY;
  if (!raw && !isSupabaseEnabled()) return ephemeralKey();
  if (!raw) {
    throw new ConsoleKeyError(
      `CONSOLE_SECRET_KEY is not set, so the QA account's password and TOTP secret cannot be stored encrypted. ${GENERATE_HINT}`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new ConsoleKeyError(`CONSOLE_SECRET_KEY must be exactly 32 bytes once base64-decoded. ${GENERATE_HINT}`);
  }
  return decoded;
}

/**
 * With no key set and the in-memory store, a random key is made for this
 * process. Encryption stays on; only the key is temporary. Nothing is lost by
 * that: the encrypted values live in the same process memory and disappear on
 * restart at the same moment the key does. It means a clean clone runs the
 * console with no setup at all.
 *
 * With Supabase the data outlives the process, so a temporary key would make
 * every stored credential unreadable after a restart. There the key is
 * required, and key() throws without it.
 *
 * Kept on globalThis, like the in-memory store itself, so a dev-server module
 * reload does not swap the key out from under values already stored.
 */
function ephemeralKey(): Buffer {
  const g = globalThis as unknown as { __consoleEphemeralKey?: Buffer };
  return (g.__consoleEphemeralKey ??= randomBytes(32));
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1" || !iv || !tag || ciphertext === undefined) {
    throw new ConsoleKeyError("A stored QA credential is not in a format this console can read.");
  }
  // authTagLength pins the tag to the full 16 bytes. Without it Node accepts a
  // shorter tag, which is easier to forge.
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"), { authTagLength: 16 });
  try {
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new ConsoleKeyError(
      "A stored QA credential could not be decrypted. CONSOLE_SECRET_KEY has probably changed since the project was added.",
    );
  }
}
