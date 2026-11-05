"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { createConsumerGroup, deleteConsumerGroup, renameConsumerGroup, setConsumerGroup } from "@/app/[project]/consumers/actions";
import { GROUPS_LOAD_FAILED, type GroupRollup, MAX_GROUP_NAME, RANGE_LABEL, checkGroupName, consumersHref, errorsOf, formatCount, formatRate } from "@/lib/consumers";
import type { ConsumerGroup, ConsumerGroupRef, QueryRange } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import { Sparkline } from "./charts";
import "../org-settings/members.css";
import "../org-settings/org-settings.css";

type Note = { tone: "ok" | "err"; text: string } | null;

const READ_ONLY = "You can see consumer groups. Only project admins and editors can change them.";

/**
 * The group a consumer is in, on its detail panel: a select of the project's groups (or none) and
 * Save. A consumer is in at most one group, so saving another group moves it. Project editors
 * (`project.update`) change it; everyone else sees the same control disabled, with the reason.
 */
export function GroupPicker({ project, consumer, current, groups }: { project: string; consumer: string; current: ConsumerGroupRef | null; groups: ConsumerGroup[] | null }) {
  const manage = useCan("project.update").allowed;
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(current?.id ?? "");
  const [note, setNote] = useState<Note>(null);
  const [pending, start] = useTransition();

  useEffect(() => setValue(current?.id ?? ""), [current?.id]);

  if (groups === null) {
    return (
      <p className="cs-picker cs-muted">
        Group: {current ? current.name : "None"}. {GROUPS_LOAD_FAILED}
      </p>
    );
  }
  const options = current && !groups.some((g) => g.id === current.id) ? [{ id: current.id, name: current.name }, ...groups] : groups;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!manage || pending || value === (current?.id ?? "")) return;
    const target = value || null;
    start(async () => {
      const result = await setConsumerGroup(project, consumer, target);
      if (!result.ok) {
        setNote({ tone: "err", text: result.error });
        return;
      }
      const name = options.find((g) => g.id === target)?.name;
      setNote({ tone: "ok", text: target ? `Moved to ${name}.` : "Taken out of its group." });
      router.refresh();
    });
  };

  return (
    <form className="cs-picker" onSubmit={submit}>
      <label htmlFor={id}>Group</label>
      <div className="cs-picker__row">
        <select
          id={id}
          className="om-select"
          value={value}
          disabled={!manage || pending}
          aria-describedby={manage ? undefined : `${id}-why`}
          onChange={(e) => {
            setValue(e.target.value);
            setNote(null);
          }}
        >
          <option value="">No group</option>
          {options.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        {manage ? (
          <button type="submit" className={`ah-btn ah-btn--secondary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending || value === (current?.id ?? "")}>
            Save
          </button>
        ) : null}
      </div>
      {manage ? null : (
        <p id={`${id}-why`} className="cs-hint">
          Only project admins and editors can change it.
        </p>
      )}
      <p className={`cs-hint${note?.tone === "err" ? " cs-hint--err" : ""}`} role="status" aria-live="polite">
        {note?.text ?? ""}
      </p>
    </form>
  );
}

/**
 * The groups view: each consumer group with how many consumers it holds and the traffic of those
 * seen in the range, linking to the consumer list filtered by the group. Project editors create,
 * rename and delete groups here; everyone else sees the table read-only.
 */
export function GroupsManager({ project, range, groups, rollups }: { project: string; range: QueryRange; groups: ConsumerGroup[] | null; rollups: GroupRollup[] }) {
  const manage = useCan("project.update").allowed;
  if (groups === null) {
    return (
      <div className="cs-notice cs-notice--error" role="alert">
        <ObIcon name="info" />
        <p>
          {GROUPS_LOAD_FAILED}{" "}
          <a className="cp-link" href={consumersHref(project, { range, by: "groups" })}>
            Try again
          </a>
        </p>
      </div>
    );
  }
  return (
    <>
      {manage ? (
        <CreateGroup project={project} />
      ) : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>{READ_ONLY}</span>
        </p>
      )}
      {groups.length === 0 ? (
        <div className="cs-notice" role="status">
          <ObIcon name="info" />
          <p>No consumer groups yet. Create one, then put consumers in it from each consumer’s detail.</p>
        </div>
      ) : (
        <div className="cs-card">
          <table className="cs-table" aria-label="Consumer groups">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col" className="cs-num">
                  Consumers
                </th>
                <th scope="col" className="cs-num">
                  Requests
                </th>
                <th scope="col" className="cs-num">
                  Errors
                </th>
                {manage ? (
                  <th scope="col">
                    <span className="cs-sr">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rollups.map((r) => (
                <GroupRow key={r.group.id} project={project} range={range} r={r} manage={manage} />
              ))}
            </tbody>
          </table>
          <p className="cs-note cs-note--card">Requests and errors of each group’s consumers in the last {RANGE_LABEL[range]}.</p>
        </div>
      )}
    </>
  );
}

function CreateGroup({ project }: { project: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [pending, start] = useTransition();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const checked = checkGroupName(name);
    if (!checked.ok) {
      setNote({ tone: "err", text: checked.error });
      return;
    }
    start(async () => {
      const result = await createConsumerGroup(project, checked.name);
      if (!result.ok) {
        setNote({ tone: "err", text: result.error });
        return;
      }
      setName("");
      setNote({ tone: "ok", text: `Created ${checked.name}.` });
      router.refresh();
    });
  };

  return (
    <form className="cs-create" onSubmit={submit} noValidate>
      <label className="ob-l" htmlFor="cs-new-group">
        New group
      </label>
      <div className="cs-create__row">
        <div className={`ob-in${note?.tone === "err" ? " bad" : ""}`}>
          <input
            id="cs-new-group"
            value={name}
            placeholder="Partners"
            maxLength={MAX_GROUP_NAME + 20}
            autoComplete="off"
            aria-invalid={note?.tone === "err"}
            aria-describedby="cs-new-group-note"
            onChange={(e) => {
              setName(e.target.value);
              setNote(null);
            }}
          />
        </div>
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
          Create group
        </button>
      </div>
      <p id="cs-new-group-note" className={`cs-hint${note?.tone === "err" ? " cs-hint--err" : ""}`} role="status" aria-live="polite">
        {note?.text ?? ""}
      </p>
    </form>
  );
}

function GroupRow({ project, range, r, manage }: { project: string; range: QueryRange; r: GroupRollup; manage: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(r.group.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const errors = errorsOf(r);

  useEffect(() => {
    if (mode === "rename") input.current?.focus();
  }, [mode]);

  const reset = () => {
    setMode("view");
    setName(r.group.name);
    setError(null);
  };

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const checked = checkGroupName(name);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    if (checked.name === r.group.name) return reset();
    start(async () => {
      const result = await renameConsumerGroup(project, r.group.id, checked.name);
      if (!result.ok) return setError(result.error);
      setMode("view");
      setError(null);
      router.refresh();
    });
  };

  const remove = () => {
    if (pending) return;
    start(async () => {
      const result = await deleteConsumerGroup(project, r.group.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  };

  return (
    <tr className="cs-row">
      <td className="cs-who" data-label="Group">
        {mode === "rename" ? (
          <form className="cs-rename" onSubmit={rename} noValidate>
            <div className={`ob-in${error ? " bad" : ""}`}>
              <input
                ref={input}
                value={name}
                aria-label={`New name for ${r.group.name}`}
                maxLength={MAX_GROUP_NAME + 20}
                autoComplete="off"
                aria-invalid={error !== null}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") reset();
                }}
              />
            </div>
            <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
              Save
            </button>
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={reset} disabled={pending}>
              Cancel
            </button>
          </form>
        ) : (
          <a className="cs-name" href={consumersHref(project, { range, group: r.group.id })}>
            {r.group.name}
          </a>
        )}
        {mode === "delete" ? (
          <p className="cs-confirm" role="alert">
            Delete {r.group.name}? Its {formatCount(r.group.consumers)} {r.group.consumers === 1 ? "consumer becomes" : "consumers become"} ungrouped.
          </p>
        ) : null}
        {error ? <p className="cs-hint cs-hint--err">{error}</p> : null}
      </td>
      <td className="cs-num" data-label="Consumers">
        {formatCount(r.group.consumers)}
      </td>
      <td className="cs-num" data-label="Requests">
        <span className="cs-reqs">
          <Sparkline values={r.sparkline} />
          <span>{formatCount(r.requests)}</span>
        </span>
      </td>
      <td className="cs-num" data-label="Errors">
        {errors > 0 ? (
          <span title={`${formatCount(r.client_errors)} 4xx, ${formatCount(r.server_errors)} 5xx`}>
            {formatCount(errors)} <span className="cs-muted">({formatRate(errors, r.requests)})</span>
          </span>
        ) : (
          <span className="cs-muted">0</span>
        )}
      </td>
      {manage ? (
        <td className="cs-actions">
          {mode === "delete" ? (
            <>
              <button type="button" className={`ah-btn ah-btn--sm os-btn-outline-danger${pending ? " is-loading" : ""}`} onClick={remove} disabled={pending}>
                Delete group
              </button>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={reset} disabled={pending}>
                Cancel
              </button>
            </>
          ) : mode === "view" ? (
            <>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setMode("rename")} aria-label={`Rename ${r.group.name}`}>
                Rename
              </button>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setMode("delete")} aria-label={`Delete ${r.group.name}`}>
                Delete
              </button>
            </>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}
