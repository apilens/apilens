"use client";

import { useTheme } from "next-themes";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { MoonIcon, SunIcon } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/tooltip";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // Theme is unknown during SSR; render the dark-default icon until hydrated.
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const isDark = !mounted || resolvedTheme !== "light";
  const next = isDark ? "light" : "dark";

  return (
    <Tooltip content={`Switch to ${next} theme`}>
      <Button variant="ghost" size="icon" aria-label={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
        {isDark ? <SunIcon /> : <MoonIcon />}
      </Button>
    </Tooltip>
  );
}
