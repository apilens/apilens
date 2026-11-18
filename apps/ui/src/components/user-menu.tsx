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

/**
 * Account: you, account settings, appearance, sign out. At the foot of the sidebar it opens upward;
 * in the top bar (`placement="top"`) it is the avatar alone and opens down from the right edge.
 * `current`: the page is the account section (`/settings/*`).
 */
export function UserMenu({ user, collapsed = false, current = false, placement = "side" }: { user: Pick<User, "name" | "email">; collapsed?: boolean; current?: boolean; placement?: "side" | "top" }) {
  const top = placement === "top";
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
      <button ref={trigger} type="button" className={`me-btn${top ? " me-btn--top" : ""}${open ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu, ${me.name}`} data-tip={(collapsed || top) && !open ? me.name : undefined} onClick={() => setOpen((o) => !o)}>
        <span className="cp-av">{me.initials}</span>
        {top ? null : (
          <span className="me-txt">
            <b>{me.name}</b>
            <small>{me.email}</small>
          </span>
        )}
      </button>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label="Account" align={top ? "end" : collapsed ? "side-up" : "up"}>
        {top ? (
          <div className="me-who">
            <b>{me.name}</b>
            <small>{me.email}</small>
          </div>
        ) : null}
        <Link href="/settings" role="menuitem" className={`cp-sitem${current ? " on" : ""}`} aria-current={current ? "page" : undefined} onClick={close}>
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
