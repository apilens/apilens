import { describe, expect, it } from "vitest";
import { emailDomain, joinError } from "./join-org";

describe("emailDomain", () => {
  it("answers the lower-case domain", () => {
    expect(emailDomain("Grace@Example.COM")).toBe("example.com");
    expect(emailDomain("a@b@sub.example.com.")).toBe("sub.example.com");
  });

  it("is empty without one", () => {
    expect(emailDomain("nobody")).toBe("");
  });
});

describe("joinError", () => {
  it("names the organization when it can no longer be joined", () => {
    expect(joinError("forbidden", "Globex")).toContain("You can no longer join Globex.");
    expect(joinError("not_found", "Globex")).toContain("You can no longer join Globex.");
  });

  it("maps transport failures and anything else", () => {
    expect(joinError("unavailable", "Globex")).toBe("We couldn’t reach APILens. Check your connection and try again.");
    expect(joinError("server_error", "Globex")).toBe("Something went wrong. Try again in a moment.");
  });
});
