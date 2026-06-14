import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time bearer-token check.
 *
 * The runner is a network-exposed service that can run arbitrary git/build
 * commands, so every mutating endpoint MUST be authenticated. The token is read
 * once from the environment at boot. If no token is configured we refuse to
 * authorize anything (fail closed) rather than running open to the internet.
 */
export function makeAuthorizer(expectedToken) {
  const expected = typeof expectedToken === 'string' ? expectedToken.trim() : '';
  const configured = expected.length > 0;

  return {
    configured,
    /** @returns {boolean} true when the Authorization header carries the token. */
    check(headerValue) {
      if (!configured) return false;
      const provided = extractBearer(headerValue);
      if (!provided) return false;
      return safeEqual(provided, expected);
    },
  };
}

/** Pull the raw token out of an `Authorization: Bearer <token>` header. */
export function extractBearer(headerValue) {
  if (typeof headerValue !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : '';
}

/** Length-safe constant-time string comparison. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch; pad to equal length while still
  // forcing the comparison to fail for differing lengths.
  if (bufA.length !== bufB.length) {
    // Compare against itself to spend comparable time, then return false.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
