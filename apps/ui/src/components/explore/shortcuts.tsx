"use client";

import { useRef, useState } from "react";
import { PopMenu } from "../pop-menu";

const KEYS: [string, string][] = [
  ["↑ ↓ or k j", "Move the open row"],
  ["Shift ↑ ↓", "Extend the selection"],
  ["Enter", "Open the focused row"],
  ["Esc", "Close the drawer, then clear the selection"],
  ["Shift F", "Focus the filter bar"],
  ["F then C", "Clear filters"],
  ["⌘ J", "Pause or resume Live"],
  ["⌘ U", "Reset columns"],
  ["?", "Show these shortcuts"],
];

/** Explore's keyboard shortcuts (#1053), in a small popover from "?" (the key or the button). */
export function Shortcuts() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={trigger}
        id="ex-shortcuts"
        type="button"
        className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn ex-tbtn--icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={trigger} label="Keyboard shortcuts" role="dialog" align="end">
        <table className="exk">
          <caption className="ex-sr">Keyboard shortcuts</caption>
          <tbody>
            {KEYS.map(([k, what]) => (
              <tr key={k}>
                <th scope="row">
                  <kbd>{k}</kbd>
                </th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PopMenu>
    </>
  );
}
