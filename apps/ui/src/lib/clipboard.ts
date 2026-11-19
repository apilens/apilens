// Copying text that works in Safari as well as Chrome and Firefox. Safari only lets a page write
// the clipboard from inside the user's click: a `writeText` after an `await` (or from a timer) is
// refused. So the write starts synchronously in the handler: `clipboard.write` with a
// `ClipboardItem` whose blob is a promise (Safari's own way to copy data that is still being
// built; Chrome and Firefox take it too), else `writeText`, and where the async clipboard is
// missing (an http:// LAN address is not a secure context) or refuses, a hidden textarea and
// `execCommand("copy")`. Callers call `copyText` first thing in the click handler, then show
// their "Copied" feedback from the answer.

/** The `execCommand("copy")` fallback: copies `text` through a hidden textarea; whether it worked. */
export function execCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as HTMLElement | null;
  const sel = document.getSelection();
  const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  // Off screen but rendered (Safari will not select a display:none field), and 16px so iOS does not zoom.
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px;";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    ta.remove();
    active?.focus?.({ preventScroll: true });
    if (sel) {
      sel.removeAllRanges();
      for (const r of ranges) sel.addRange(r);
    }
  }
  return ok;
}

/**
 * Copies `source` (text, or a promise of it for data still being built), answering whether it
 * worked. Call it synchronously inside the click (or key) handler: no `await` before it.
 */
export function copyText(source: string | Promise<string>): Promise<boolean> {
  const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const text = Promise.resolve(source);
  let attempt: Promise<unknown>;
  try {
    if (clip?.write && typeof ClipboardItem !== "undefined") {
      attempt = clip.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
    } else if (clip?.writeText) {
      attempt = typeof source === "string" ? clip.writeText(source) : text.then((t) => clip.writeText(t));
    } else if (typeof source === "string") {
      // No async clipboard (not a secure context): the fallback, still inside the click.
      return Promise.resolve(execCopy(source));
    } else {
      attempt = Promise.reject(new Error("no clipboard"));
    }
  } catch (err) {
    attempt = Promise.reject(err);
  }
  return attempt.then(
    () => true,
    async () => {
      // A refused ClipboardItem (an older engine) may still take plain writeText, then the textarea.
      try {
        if (clip?.writeText) {
          await clip.writeText(await text);
          return true;
        }
      } catch {}
      try {
        return execCopy(await text);
      } catch {
        return false;
      }
    },
  );
}
