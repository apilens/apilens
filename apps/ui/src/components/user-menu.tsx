"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import type { User } from "@/lib/identity";
import { userLabel } from "@/lib/scope";
import { signOut } from "@/lib/sign-out";
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
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => setMounted(true), []);
  const close = () => setOpen(false);

  // The Route Handler revokes the session and clears the cookie; a full navigation then drops
  // every bit of client state that belonged to the signed-in user.
  const onSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    window.location.assign(await signOut());
  };

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
        <Link href="/settings/profile" role="menuitem" className="cp-sitem" onClick={close}>
          <span className="sl">
            <Icon name="settings" />
          </span>
          <span className="lb">Account settings</span>
        </Link>
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
        <button type="button" role="menuitem" className="cp-sitem" disabled={signingOut} aria-busy={signingOut} onClick={onSignOut}>
          <span className="sl">
            <Icon name="logout" />
          </span>
          <span className="lb">{signingOut ? "Signing out…" : "Sign out"}</span>
        </button>
      </PopMenu>
    </>
  );
}
