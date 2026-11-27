"use client";

import { type KeyboardEvent, useId, useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { radioKeyTarget } from "@/lib/radio-group";
import { RELEASE_SDKS, type ReleaseSdk, releaseSnippets } from "@/lib/release-setup";
import "../project-settings/sdk-setup.css";

/**
 * How to record deploys (#997): one tab per SDK (`sdks`, picked by the page: the ones the project's
 * apps run, or every SDK), each with the config that stamps the release and commit on every record
 * and the same two values as environment variables. Arrow keys move between tabs.
 */
export function RecordDeploys({ sdks }: { sdks: readonly ReleaseSdk[] }) {
  const tabs = RELEASE_SDKS.filter((t) => sdks.includes(t.id)).sort((a, b) => sdks.indexOf(a.id) - sdks.indexOf(b.id));
  const shown = tabs.length ? tabs : RELEASE_SDKS;
  const [sdk, setSdk] = useState<ReleaseSdk>(shown[0].id);
  const id = useId();
  const tabId = (s: string) => `${id}-${s}`;
  const current = shown.find((t) => t.id === sdk) ?? shown[0];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = shown.findIndex((t) => t.id === current.id);
    const to = radioKeyTarget(e.key, from, shown.map(() => false));
    if (to === null) return;
    e.preventDefault();
    setSdk(shown[to].id);
    document.getElementById(tabId(shown[to].id))?.focus();
  };
  return (
    <div className="ch-record">
      <div className="sdk-tabs" role="tablist" aria-label="SDK" onKeyDown={onKeyDown}>
        {shown.map((t) => (
          <button
            key={t.id}
            id={tabId(t.id)}
            type="button"
            role="tab"
            aria-selected={t.id === current.id}
            aria-controls={`${id}-panel`}
            tabIndex={t.id === current.id ? 0 : -1}
            onClick={() => setSdk(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="sdk-panel ins-snippets" role="tabpanel" id={`${id}-panel`} aria-labelledby={tabId(current.id)}>
        {releaseSnippets(current.id).map((s) => (
          <CodeBlock key={`${current.id}-${s.id}`} snippet={s} />
        ))}
      </div>
    </div>
  );
}
