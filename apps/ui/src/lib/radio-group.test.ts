import { describe, expect, it } from "vitest";
import { radioKeyTarget, radioTabStop } from "./radio-group";

const none = [false, false, false, false];
const someOff = [false, true, false, true];

describe("radioKeyTarget", () => {
  it("moves forward and back with the arrow keys, wrapping", () => {
    expect(radioKeyTarget("ArrowDown", 0, none)).toBe(1);
    expect(radioKeyTarget("ArrowRight", 3, none)).toBe(0);
    expect(radioKeyTarget("ArrowUp", 0, none)).toBe(3);
    expect(radioKeyTarget("ArrowLeft", 2, none)).toBe(1);
  });

  it("skips disabled radios", () => {
    expect(radioKeyTarget("ArrowRight", 0, someOff)).toBe(2);
    expect(radioKeyTarget("ArrowRight", 2, someOff)).toBe(0);
    expect(radioKeyTarget("ArrowLeft", 0, someOff)).toBe(2);
  });

  it("jumps to the first and last enabled radio with Home and End", () => {
    expect(radioKeyTarget("Home", 2, [true, false, false, false])).toBe(1);
    expect(radioKeyTarget("End", 0, someOff)).toBe(2);
  });

  it("ignores other keys and groups with nothing to pick", () => {
    expect(radioKeyTarget("Enter", 0, none)).toBeNull();
    expect(radioKeyTarget("ArrowDown", 0, [true, true])).toBeNull();
    expect(radioKeyTarget("ArrowDown", 0, [])).toBeNull();
  });
});

describe("radioTabStop", () => {
  it("is the checked radio, else the first enabled one", () => {
    expect(radioTabStop(2, none)).toBe(2);
    expect(radioTabStop(-1, none)).toBe(0);
    expect(radioTabStop(-1, [true, false])).toBe(1);
    expect(radioTabStop(1, someOff)).toBe(0);
  });
});
