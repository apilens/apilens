import { describe, expect, it } from "vitest";
import { suggestEmail } from "./email-typo";

describe("suggestEmail", () => {
  it.each([
    ["ada@gmial.com", "ada@gmail.com"],
    ["ada@gmai.com", "ada@gmail.com"],
    ["ada@gmail.con", "ada@gmail.com"],
    ["ada@gmial.con", "ada@gmail.com"],
    ["Ada.Lovelace@GMAIL.CMO", "Ada.Lovelace@gmail.com"],
    ["ada@hotmial.com", "ada@hotmail.com"],
    ["ada@gamil.com", "ada@gmail.com"],
    ["ada@mns.com", "ada@msn.com"],
    ["ada@outlok.com", "ada@outlook.com"],
    ["ada@yaho.com", "ada@yahoo.com"],
    ["ada@icloud.co", "ada@icloud.com"],
    ["ada@acme.con", "ada@acme.com"],
    ["  ada@gmial.com ", "ada@gmail.com"],
  ])("%s → %s", (typed, suggested) => {
    expect(suggestEmail(typed)).toBe(suggested);
  });

  it.each([
    "ada@gmail.com",
    "ada@acme.com",
    "ada@acme.io",
    "ada@example.com",
    "ada@mail.com",
    "ada@company.co.uk",
    "not-an-email",
    "@gmail.com",
    "ada@",
    "",
  ])("leaves %s alone", (typed) => {
    expect(suggestEmail(typed)).toBeNull();
  });
});
