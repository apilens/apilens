// Typed confirmation (#802): the one rule every "type X to confirm" field uses, so the dialog,
// the Server Action that re-checks it and every screen agree on what counts as a match.

/**
 * Whether `typed` confirms `expected`.
 *
 * - Surrounding whitespace is ignored on both sides (pasting often brings a trailing space or newline).
 * - Case **matters** by default: slugs, key names and project names are compared exactly, so
 *   `Acme` does not confirm `acme`. Pass `{ ignoreCase: true }` only for values that are
 *   case-insensitive by nature, such as email addresses.
 * - An empty `expected` never matches, so a missing value cannot be confirmed by typing nothing.
 */
export function confirmMatches(expected: string, typed: string, opts: { ignoreCase?: boolean } = {}): boolean {
  let want = expected.trim();
  let got = typed.trim();
  if (want === "") return false;
  if (opts.ignoreCase) {
    want = want.toLowerCase();
    got = got.toLowerCase();
  }
  return got === want;
}
