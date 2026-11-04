"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import type { User } from "@/lib/identity";
import { userLabel } from "@/lib/scope";
import { Icon, type IconName } from "./icons";
import { PopMenu } from "./pop-menu";

const THEMES: { value: "dark" | "light"; label: string; icon: IconName }[] = [
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "light", label: "Light", icon: "sun" },
];

/** Account, at the foot of the sidebar: you, account settings, appearance, sign out. Opens upward. */
export function UserMenu({ user, collapsed = false }: { user: Pick<User, "name" | "email">; collapsed?: boolean }) {
  const me = userLabel(user);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setMounted(true), []);
  const close = () => setOpen(false);

  const item = (icon: IconName, label: string, extra?: string) => (
    <button type="button" role="menuitem" className="cp-sitem" onClick={close}>
      <span className="sl">
        <Icon name={icon} />
      </span>
      <span className="lb">{label}</span>
      {extra ? <span className="ah-kbd">{extra}</span> : null}
    </button>
  );

  return (
    <>
      <button ref={trigger} type="button" className={`me-btn${open ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu, ${me.name}`} data-tip={collapsed && !open ? me.name : undefined} onClick={() => setOpen((o) => !o)}>
        <span className="cp-av">{me.initials}</span>
        <span className="me-txt">
          <b>{me.name}</b>
          <small>{me.email}</small>
        </span>
      </button>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label="Account" align={collapsed ? "side-up" : "up"}>
        {item("settings", "Account settings")}
        <hr />
        <p className="menu-label">Appearance</p>
        {THEMES.map((t) => (
          <button key={t.value} type="button" role="menuitemradio" aria-checked={mounted && theme === t.value} className="cp-sitem" onClick={() => setTheme(t.value)}>
            <span className="sl">
              <Icon name={t.icon} />
            </span>
            <span className="lb">{t.label}</span>
            {mounted && theme === t.value ? (
              <span className="sl">
                <Icon name="check" />
              </span>
            ) : null}
          </button>
        ))}
        <hr />
        <Link href="/sign-in" role="menuitem" className="cp-sitem" onClick={close}>
          <span className="sl">
            <Icon name="logout" />
          </span>
          <span className="lb">Sign out</span>
        </Link>
      </PopMenu>
    </>
  );
}
