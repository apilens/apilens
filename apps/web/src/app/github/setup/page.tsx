"use client";

/* GitHub App setup callback. GitHub redirects here after install/update with
   ?installation_id=…&state=…. The installation_id is untrusted (docs warn it
   can be spoofed) — the backend verifies the signed state and the
   installation against GitHub before linking anything. */

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

function GitHubSetupInner() {
  const params = useSearchParams();
  const router = useRouter();
  const ran = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const installationId = params.get("installation_id");
    const state = params.get("state");
    if (!installationId || !state) {
      setError("Missing installation parameters — start the connection from project settings.");
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/integrations/github/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installation_id: Number(installationId), state }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.detail || data.error || "Failed to complete the GitHub connection");
        }
        router.replace(`/projects/${data.project_slug}/settings/integrations`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to complete the GitHub connection");
      }
    })();
  }, [params, router]);

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "60vh", textAlign: "center", padding: 24 }}>
      {error ? (
        <div>
          <p style={{ marginBottom: 8 }}>{error}</p>
          <p className="settings-inline-help">
            You can close this page and retry from your project&apos;s Settings → Integrations.
          </p>
        </div>
      ) : (
        <div>
          <Loader2 size={22} className="animate-spin" style={{ marginBottom: 8 }} />
          <p>Finishing GitHub connection…</p>
        </div>
      )}
    </div>
  );
}

export default function GitHubSetupPage() {
  return (
    <Suspense fallback={null}>
      <GitHubSetupInner />
    </Suspense>
  );
}
