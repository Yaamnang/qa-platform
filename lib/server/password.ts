import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing, kept in its own module so both storage backends can use it
 * without importing each other. Importing store.ts for this would build the
 * whole in-memory database as a side effect.
 *
 * scrypt with a per-password random salt, stored as "saltHex:hashHex".
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), 32);
  return timingSafeEqual(expected, actual);
}
