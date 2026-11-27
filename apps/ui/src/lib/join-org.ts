// Joining an organization by verified email domain (#329): the domain of an address and the
// sentence Welcome shows when a join failed. Pure, so it can be unit tested.

/** The domain of `email` (lower-case, without "@"), or "" when it has none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
}

/** The sentence Welcome shows when joining `orgName` failed with API error `code`. */
export function joinError(code: string, orgName: string): string {
  switch (code) {
    case "forbidden":
    case "not_found":
      return `You can no longer join ${orgName}. Its owners may have turned off joining by email domain.`;
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
