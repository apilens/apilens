"use client";

import { type KeyboardEvent, useId, useState } from "react";
import { CodeBlock } from "@/components/onboarding/install";
import { CONSUMER_SDKS, type ConsumerSdk, consumerDocsUrl, consumerSnippet } from "@/lib/consumer-setup";
import { LINKS, extLink } from "@/lib/links";
import { radioKeyTarget } from "@/lib/radio-group";
import "../onboarding/install.css";
import "../project-settings/sdk-setup.css";

/**
 * How to identify consumers (#989): one tab per SDK the project's apps run (`sdks`, picked by the
 * page), each with the snippet that sets the consumer and its group on each request and a link to
 * its docs section. Arrow keys move between tabs.
 */
export function IdentifyConsumers({ sdks }: { sdks: readonly ConsumerSdk[] }) {
  const tabs = CONSUMER_SDKS.filter((t) => sdks.includes(t.id)).sort((a, b) => sdks.indexOf(a.id) - sdks.indexOf(b.id));
  const shown = tabs.length ? tabs : CONSUMER_SDKS;
  const [sdk, setSdk] = useState<ConsumerSdk>(shown[0].id);
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
    <div className="cs-identify">
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
        <CodeBlock snippet={consumerSnippet(current.id)} />
        <p className="sdk-note">
          <a className="cp-link" {...extLink(consumerDocsUrl(LINKS.docs, current.id))}>
            Identifying consumers with {current.framework}
          </a>
        </p>
      </div>
    </div>
  );
}
