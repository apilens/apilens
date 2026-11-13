"use client";

// Changing access on Access › Members (#807): "Add people" (org members without a direct role,
// searched and multi-selected, one role for all of them), and a row menu to change a person's role
// or remove them from the project. Before a change is confirmed the dialog says what the person
// keeps through the organization or the project default. Holders of `access.manage` use them;
// everyone else sees them disabled with the reason. Org owners and admins show a locked role.
// Sensitive (D12): a `reauth_required` answer opens the re-authentication dialog and retries once.
// Results go to the page's status line, never a toast.
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { addProjectMembers, changeProjectRole, removeProjectMember } from "@/app/[project]/access/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Gated } from "@/components/org-settings/controls";
import { PopMenu } from "@/components/pop-menu";
import { useReauth } from "@/components/reauth-dialog";
import { type Candidate, MAX_ADD, changeConsequence, personName, removeConsequence, removedMessage } from "@/lib/access-changes";
import type { AccessMember, ProjectRole } from "@/lib/identity";
import { matchesQuery } from "@/lib/list-search";
import type { Gate } from "@/lib/org-members";
import { useCan } from "@/lib/permissions";
import { PROJECT_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, memberChange } from "@/lib/project-access";
import { REAUTH_CANCELLED } from "@/lib/reauth";
import "./manage.css";

export type Announce = (status: { tone: "ok" | "err"; text: string }) => void;

const gateOf = (allowed: boolean, reason: string | undefined): Gate => (allowed ? { allowed: true } : { allowed: false, reason: reason ?? "You can’t change this." });

/**
 * A modal `<dialog>`: labelled by its title, focus moves into it, Escape cancels (not while it
 * saves), and focus returns to `returnTo` when it closes.
 */
function AccessDialog({
  open,
  title,
  onClose,
  pending,
  returnTo,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  pending: boolean;
  returnTo: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) {
      d.close();
      returnTo.current?.focus();
    }
  }, [open, returnTo]);
  return (
    <dialog
      ref={ref}
      className="om-dialog am-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      {open ? (
        <div className="om-dialog__in">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

/** The role picker: one radio per role with its one-line description (ROLE_DESCRIPTIONS). */
function RolePicker({ value, onChange, name, disabled }: { value: ProjectRole; onChange: (r: ProjectRole) => void; name: string; disabled: boolean }) {
  return (
    <fieldset className="am-roles" disabled={disabled}>
      <legend className="ob-l">Role</legend>
      {PROJECT_ROLES.map((r) => (
        <label key={r} className={`am-roleopt${value === r ? " on" : ""}`}>
          <input type="radio" name={name} value={r} checked={value === r} onChange={() => onChange(r)} />
          <span>
            <b>{ROLE_LABELS[r]}</b>
            <span>{ROLE_DESCRIPTIONS[r]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * "Add people": the button above the list and its dialog. `candidates` is null when the
 * organization's members could not be loaded.
 */
export function AddPeople({ project, projectName, candidates, announce }: { project: string; projectName: string; candidates: Candidate[] | null; announce: Announce }) {
  const can = useCan("access.manage");
  const router = useRouter();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<ProjectRole>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { withReauth, dialog: reauthDialog } = useReauth();
  const ids = { search: useId(), err: useId(), list: useId() };

  const close = () => {
    setOpen(false);
    setQuery("");
    setPicked([]);
    setRole("viewer");
    setError(null);
  };
  const shown = (candidates ?? []).filter((c) => matchesQuery(query, [c.name, c.email]));
  const toggle = (id: string) => {
    setError(null);
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const people = (candidates ?? []).filter((c) => picked.includes(c.user_id)).map((c) => ({ userId: c.user_id, name: personName(c) }));
    if (people.length === 0) {
      setError("Choose at least one person.");
      return;
    }
    if (people.length > MAX_ADD) {
      setError(`Add at most ${MAX_ADD} people at a time.`);
      return;
    }
    start(async () => {
      const result = await withReauth(() => addProjectMembers(project, people, role, projectName));
      if (result.ok) {
        announce({ tone: "ok", text: result.message });
        close();
        router.refresh();
      } else if (result.code !== REAUTH_CANCELLED) setError(result.error);
    });
  };

  const count = picked.length;
  return (
    <>
      <Gated gate={gateOf(can.allowed, "Only project admins can add people.")}>
        {(describedBy, disabled) => (
          <button ref={button} type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={() => setOpen(true)} disabled={disabled} aria-describedby={describedBy}>
            Add people
          </button>
        )}
      </Gated>
      <AccessDialog open={open} title={`Add people to ${projectName}`} onClose={close} pending={pending} returnTo={button}>
        {candidates === null ? (
          <>
            <p className="om-dialog__p" role="alert">
              Couldn’t load the organization’s members. Reload the page to try again.
            </p>
            <div className="om-dialog__row">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} autoFocus>
                Close
              </button>
            </div>
          </>
        ) : candidates.length === 0 ? (
          <>
            <p className="om-dialog__p">Everyone in the organization already has a role on {projectName} of their own, or is an organization owner or admin.</p>
            <div className="om-dialog__row">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} autoFocus>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="om-dialog__p">Give organization members a role on {projectName}. Their highest role from any source applies.</p>
            <div className="ob-f">
              <label className="ob-l" htmlFor={ids.search}>
                Search organization members
              </label>
              <div className="ob-in">
                <input
                  id={ids.search}
                  type="search"
                  value={query}
                  placeholder="Name or email"
                  autoComplete="off"
                  spellCheck={false}
                  aria-controls={ids.list}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <fieldset className="am-pick" disabled={pending} aria-describedby={error ? ids.err : undefined}>
              <legend className="ob-l">
                People <small>{count === 0 ? "none selected" : `${count} selected`}</small>
              </legend>
              <ul className="am-pick__list" id={ids.list}>
                {shown.map((c) => (
                  <li key={c.user_id}>
                    <label className={`am-pick__row${picked.includes(c.user_id) ? " on" : ""}`}>
                      <input type="checkbox" checked={picked.includes(c.user_id)} onChange={() => toggle(c.user_id)} />
                      <span className="cp-av" aria-hidden="true">
                        {c.initials}
                      </span>
                      <span className="om-who__t">
                        <span className="om-name">{personName(c)}</span>
                        {c.name && c.name !== c.email ? <span className="om-email">{c.email}</span> : null}
                      </span>
                    </label>
                  </li>
                ))}
                {shown.length === 0 ? <li className="am-pick__none">Nobody matches “{query.trim()}”.</li> : null}
              </ul>
            </fieldset>
            <RolePicker value={role} onChange={setRole} name="am-add-role" disabled={pending} />
            {error ? (
              <p id={ids.err} className="ob-err" role="alert">
                {error}
              </p>
            ) : null}
            <div className="om-dialog__row">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
                Cancel
              </button>
              <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
                {count > 1 ? `Add ${count} people` : "Add person"}
              </button>
            </div>
          </form>
        )}
      </AccessDialog>
      {reauthDialog}
    </>
  );
}

/**
 * The menu on one row: change role, remove from project. Org owners and admins get a locked role
 * with the reason; without `access.manage` the button is disabled with the reason.
 */
export function MemberRowMenu({ project, projectName, member, announce }: { project: string; projectName: string; member: AccessMember; announce: Announce }) {
  const can = useCan("access.manage");
  const change = memberChange(member, can.allowed);
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [role, setRole] = useState<ProjectRole>(member.direct_role ?? member.effective_role);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { withReauth, dialog: reauthDialog } = useReauth();
  const name = personName(member);
  const closeMenu = useCallback(() => setMenu(false), []);

  // Keyboard users land on the first item when the menu opens.
  useEffect(() => {
    if (!menu) return;
    const frame = requestAnimationFrame(() => document.getElementById(menuId)?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [menu, menuId]);

  const pick = (open: () => void) => {
    setMenu(false);
    setError(null);
    trigger.current?.focus();
    open();
  };

  const closeEdit = () => {
    setEditing(false);
    setError(null);
    setRole(member.direct_role ?? member.effective_role);
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    start(async () => {
      const result = await withReauth(() => changeProjectRole(project, member.user_id, role, name, projectName));
      if (result.ok) {
        announce({ tone: "ok", text: result.message });
        setEditing(false);
        router.refresh();
      } else if (result.code !== REAUTH_CANCELLED) setError(result.error);
    });
  };

  const remove = () => {
    if (pending) return;
    start(async () => {
      const result = await withReauth(() => removeProjectMember(project, member.user_id, removedMessage(member, projectName)));
      if (result.ok) {
        announce({ tone: "ok", text: result.message });
        setRemoving(false);
        router.refresh();
      } else if (result.code !== REAUTH_CANCELLED) setError(result.error);
    });
  };

  if (!change.changeRole && change.reason && can.allowed) {
    // An org owner or admin: Admin everywhere, nothing to change here.
    return (
      <Gated gate={{ allowed: false, reason: change.reason }}>
        {(describedBy) => (
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm am-menu-btn" disabled aria-label={`Role of ${name} is locked`} aria-describedby={describedBy}>
            Locked
          </button>
        )}
      </Gated>
    );
  }

  const consequence = changeConsequence(member, role);
  return (
    <>
      <Gated gate={gateOf(change.changeRole || change.remove, change.reason)}>
        {(describedBy, disabled) => (
          <button
            ref={trigger}
            type="button"
            className="ah-btn ah-btn--ghost ah-btn--sm am-menu-btn"
            aria-label={`Change access for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-controls={menu ? menuId : undefined}
            aria-describedby={describedBy}
            disabled={disabled || pending}
            onClick={() => setMenu((v) => !v)}
          >
            <span aria-hidden="true">•••</span>
          </button>
        )}
      </Gated>
      <PopMenu open={menu} onClose={closeMenu} triggerRef={trigger} label={`Access of ${name}`} align="end" id={menuId}>
        <button type="button" role="menuitem" className="cp-sitem" onClick={() => pick(() => setEditing(true))}>
          Change role
        </button>
        <button type="button" role="menuitem" className="cp-sitem am-menu-danger" disabled={!change.remove} title={change.remove ? undefined : `${name} has no role of their own on ${projectName}.`} onClick={() => pick(() => setRemoving(true))}>
          Remove from project
        </button>
      </PopMenu>

      <AccessDialog open={editing} title={`Change ${name}’s role`} onClose={closeEdit} pending={pending} returnTo={trigger}>
        <form onSubmit={save} noValidate>
          <p className="om-dialog__p">The role {name} gets on {projectName} directly. Their highest role from any source applies.</p>
          <RolePicker value={role} onChange={(r) => { setRole(r); setError(null); }} name={`am-role-${member.user_id}`} disabled={pending} />
          <p className="am-consequence" aria-live="polite">
            {consequence ?? ""}
          </p>
          {error ? (
            <p className="ob-err" role="alert">
              {error}
            </p>
          ) : null}
          <div className="om-dialog__row">
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={closeEdit} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
              Save role
            </button>
          </div>
        </form>
      </AccessDialog>

      <ConfirmDialog
        open={removing}
        title={`Remove ${name} from ${projectName}?`}
        actionLabel="Remove from project"
        pending={pending}
        error={removing ? error : null}
        onConfirm={remove}
        onCancel={() => {
          setRemoving(false);
          setError(null);
        }}
      >
        <p>Their role on {projectName} of their own is removed.</p>
        <p>{removeConsequence(member, projectName)}</p>
      </ConfirmDialog>
      {reauthDialog}
    </>
  );
}
