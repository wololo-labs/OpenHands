/**
 * Constant-time session-key comparison, shared by everything that gates a
 * route on the master's key.
 *
 * It lives in its own module because both the registry routes and the fleet
 * proxy authenticate the same way, and a second hand-rolled copy is how one of
 * them ends up with `===`.
 */

import { timingSafeEqual } from "node:crypto";

export function secretMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  // Compared as bytes, not characters: a non-ASCII value of the same string
  // length produces a different buffer length, which timingSafeEqual throws on.
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
