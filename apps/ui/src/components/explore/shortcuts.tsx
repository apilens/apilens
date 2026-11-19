"use client";

import type { RefObject } from "react";
import { PopMenu } from "../pop-menu";

const KEYS: [string, string][] = [
  ["↑ ↓ or k j", "Move the open row"],
  ["Shift ↑ ↓", "Extend the selection"],
  ["Enter", "Open the focused row"],
  ["Esc", "Close the drawer, then clear the selection"],
  ["Shift F or /", "Focus the filter bar"],
  ["⌫ in the empty bar", "Select the last filter, again to remove it"],
  ["← →", "Move between filters"],
  ["F then C", "Clear filters"],
  ["Shift R", "Refresh"],
  ["Shift E", "Export"],
  ["⌘ J", "Pause or resume Live"],
  ["⌘ U", "Reset columns"],
  ["?", "Show these shortcuts"],
];

/**
 * Explore's keyboard shortcuts (#1053), in a small popover opened with "?" (the toolbar has no
 * button for it, as Supabase's), anchored at the toolbar's end.
 */
export function Shortcuts({ open, onClose, anchor }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null> }) {
  return (
    <PopMenu open={open} onClose={onClose} triggerRef={anchor} label="Keyboard shortcuts" role="dialog" align="end">
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
  );
}
