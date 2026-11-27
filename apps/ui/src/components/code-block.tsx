"use client";

import { useCallback, useEffect, useState } from "react";
import type { Snippet } from "@/lib/install";
import { ObIcon } from "./onboarding/ob";
import "./code-block.css";

/** Copies text; `copied` flips back after a moment, `failed` asks for the keyboard instead. */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  return { copied, failed, copy };
}

export function CodeBlock({ snippet }: { snippet: Snippet }) {
  const { copied, failed, copy } = useCopy();
  return (
    <div className="ob-code ins-code">
      <div className="hd">
        <ObIcon name="code" />
        <span>{snippet.title}</span>
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => copy(snippet.code)} aria-label={`Copy ${snippet.title}`}>
          {copied ? "Copied" : failed ? "Select and copy" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0}>{snippet.code}</pre>
    </div>
  );
}
