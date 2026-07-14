"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, X, Loader2, Users } from "lucide-react";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/reui/popover";

interface PendingInvitation {
  id: string;
  project_name: string;
  project_slug: string;
  role: string;
  inviter: string;
  created_at: string;
  expires_at: string;
}

export default function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch("/api/projects/invitations/pending");
      if (!res.ok) return;
      const data = await res.json();
      setInvitations(Array.isArray(data.invitations) ? data.invitations : []);
    } catch {
      // silent — the bell is non-critical chrome
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchPending();
    const onFocus = () => fetchPending();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchPending]);

  const handleAccept = async (inv: PendingInvitation) => {
    setBusyId(inv.id);
    try {
      const res = await fetch(`/api/projects/invitations/${inv.id}/accept`, { method: "POST" });
      if (!res.ok) throw new Error();
      setInvitations((prev) => prev.filter((i) => i.id !== inv.id));
      setOpen(false);
      router.push(`/projects/${inv.project_slug}`);
      router.refresh();
    } catch {
      setBusyId(null);
    }
  };

  const handleDecline = async (inv: PendingInvitation) => {
    setBusyId(inv.id);
    try {
      const res = await fetch(`/api/projects/invitations/${inv.id}/decline`, { method: "POST" });
      if (!res.ok) throw new Error();
      setInvitations((prev) => prev.filter((i) => i.id !== inv.id));
    } catch {
      // leave it in the list so the user can retry
    } finally {
      setBusyId(null);
    }
  };

  const count = invitations.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative size-9 text-muted-foreground hover:text-foreground"
          aria-label={count > 0 ? `${count} pending invitations` : "Notifications"}
        >
          <Bell className="size-[18px]" />
          {count > 0 && (
            <Badge
              size="sm"
              radius="full"
              className="absolute right-0 top-0 border-2 border-background px-1"
            >
              {count > 9 ? "9+" : count}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[340px] p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-[13px] font-semibold text-foreground">Notifications</p>
          {count > 0 && (
            <span className="text-[11px] font-semibold text-primary">{count} pending</span>
          )}
        </div>

        {!loaded ? (
          <div className="flex flex-col items-center gap-2 px-4 py-7 text-[13px] text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            <span>Loading…</span>
          </div>
        ) : count === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-7 text-[13px] text-muted-foreground">
            <Bell size={18} />
            <span>You&apos;re all caught up.</span>
          </div>
        ) : (
          <div className="max-h-[380px] overflow-y-auto">
            {invitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-start gap-3 border-t border-border px-4 py-3.5 first:border-t-0"
              >
                <div className="mt-px flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Users size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-[13px] leading-relaxed text-foreground">
                    {inv.inviter ? <strong>{inv.inviter}</strong> : "Someone"} invited you to{" "}
                    <strong>{inv.project_name}</strong>
                  </p>
                  <p className="mb-0 mt-1 text-xs capitalize text-muted-foreground">
                    Role: {inv.role}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="xs"
                      className="font-semibold"
                      onClick={() => handleAccept(inv)}
                      disabled={busyId === inv.id}
                    >
                      {busyId === inv.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Check size={12} />
                      )}
                      Accept
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => handleDecline(inv)}
                      disabled={busyId === inv.id}
                    >
                      <X size={12} />
                      Decline
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
