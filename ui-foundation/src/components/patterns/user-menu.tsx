"use client";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CaretUpDownIcon, KeyboardIcon, SignOutIcon, UserIcon } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/tooltip";
import { CURRENT_USER } from "@/lib/demo-data";

/** Bottom of the sidebar: who is signed in. Personal settings only, never org or project settings. */
export function UserMenu({ collapsed = false, onOpenShortcuts }: { collapsed?: boolean; onOpenShortcuts: () => void }) {
  const { name, email } = CURRENT_USER;
  const trigger = collapsed ? (
    <Button variant="ghost" size="icon" aria-label={`Account menu for ${name}`}>
      <Avatar name={name} />
    </Button>
  ) : (
    <Button variant="ghost" className="h-10 w-full justify-start gap-2.5 px-2 text-left" aria-label={`Account menu for ${name}`}>
      <Avatar name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        <span className="block truncate text-2xs text-subtle-foreground">{email}</span>
      </span>
      <CaretUpDownIcon className="text-subtle-foreground" />
    </Button>
  );

  return (
    <DropdownMenu>
      {collapsed ? (
        <Tooltip side="right" content={name}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} className="w-60">
        <DropdownMenuLabel>{email}</DropdownMenuLabel>
        <DropdownMenuItem>
          <UserIcon />
          Account settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenShortcuts}>
          <KeyboardIcon />
          Keyboard shortcuts
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <SignOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
