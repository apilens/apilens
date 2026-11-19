import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

class FakeItem {
  constructor(public items: Record<string, Promise<Blob>>) {}
}

afterEach(() => vi.unstubAllGlobals());

describe("copyText", () => {
  it("writes a ClipboardItem synchronously, its blob a promise (Safari's way)", async () => {
    const write = vi.fn(async (items: FakeItem[]) => {
      expect(await (await items[0].items["text/plain"]).text()).toBe("hello");
    });
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal("ClipboardItem", FakeItem);
    const done = copyText("hello");
    // Called before any await: still inside the click.
    expect(write).toHaveBeenCalledTimes(1);
    expect(await done).toBe(true);
  });

  it("takes a promise of text, still starting the write at once", async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeItem);
    const done = copyText(Promise.resolve("later"));
    expect(write).toHaveBeenCalledTimes(1);
    expect(await done).toBe(true);
  });

  it("falls back to writeText without ClipboardItem, and when write is refused", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("a")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("a");

    const refused = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("navigator", { clipboard: { write: refused, writeText } });
    vi.stubGlobal("ClipboardItem", FakeItem);
    expect(await copyText("b")).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith("b");
  });

  it("answers false when nothing can copy", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyText("x")).toBe(false);
    expect(await copyText(Promise.resolve("x"))).toBe(false);
  });
});
