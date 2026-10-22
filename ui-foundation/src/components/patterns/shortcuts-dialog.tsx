"use client";

import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import type { NavItem } from "./nav-config";

export function ShortcutsDialog({ open, onOpenChange, items }: { open: boolean; onOpenChange: (open: boolean) => void; items: NavItem[] }) {
  const general: [string, string[]][] = [
    ["Switch project", ["O", "P"]],
    ["Collapse or expand sidebar", ["["]],
    ["Search", ["⌘", "K"]],
    ["Show keyboard shortcuts", ["?"]],
  ];
  const nav: [string, string[]][] = items.map((i) => [`Go to ${i.label.toLowerCase()}`, ["G", i.shortcut]]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press the keys one after the other, not together.</DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-5">
          {[
            ["General", general],
            ["Navigation", nav],
          ].map(([title, rows]) => (
            <section key={title as string}>
              <h3 className="mb-1 text-xs font-medium text-subtle-foreground">{title as string}</h3>
              <ul className="divide-y divide-border">
                {(rows as [string, string[]][]).map(([label, keys]) => (
                  <li key={label} className="flex h-9 items-center justify-between gap-4 text-sm text-foreground">
                    {label}
                    <span className="flex items-center gap-1">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
