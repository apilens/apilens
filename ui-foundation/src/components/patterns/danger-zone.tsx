"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/panel";
import type { Action } from "@/lib/permissions";
import { Gated } from "./gated";

export interface DangerAction {
  title: string;
  /** What happens, in plain words, including what can't be undone. */
  consequence: string;
  button: string;
  action: Action;
}

/**
 * Destructive actions live at the bottom of settings, one row each. Confirming
 * requires typing the exact resource name, which also proves the user is in
 * the tenant they think they're in.
 */
export function DangerZone({ resourceName, actions }: { resourceName: string; actions: DangerAction[] }) {
  return (
    <Panel tone="danger">
      <PanelHeader title="Danger zone" description="These actions affect everyone in the project." />
      <ul className="divide-y divide-border">
        {actions.map((a) => (
          <li key={a.title} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{a.title}</p>
              <p className="text-sm text-muted-foreground">{a.consequence}</p>
            </div>
            <ConfirmByName resourceName={resourceName} {...a} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ConfirmByName({ resourceName, title, consequence, button, action }: DangerAction & { resourceName: string }) {
  const [typed, setTyped] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const matches = typed === resourceName;

  return (
    <Dialog onOpenChange={(open) => !open && setTyped("")}>
      <Gated action={action}>
        <DialogTrigger asChild>
          <Button variant="destructive" size="md">
            {button}
          </Button>
        </DialogTrigger>
      </Gated>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{consequence}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label={`Type ${resourceName} to confirm`}>
            <Input
              autoComplete="off"
              spellCheck={false}
              mono
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!matches}
            loading={pending}
            onClick={() => {
              setPending(true);
              setTimeout(() => setPending(false), 1200);
            }}
          >
            {button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
