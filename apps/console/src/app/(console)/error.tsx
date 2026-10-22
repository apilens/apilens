"use client";

// Unexpected failures (not API states, which pages render themselves).
export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-card px-4 py-5 shadow-panel">
      <p className="text-sm font-semibold text-foreground">This view failed to render</p>
      <p className="mt-1 text-sm text-muted-foreground">The error is in the console server log. Try again, or reload the page.</p>
      <button
        type="button"
        onClick={reset}
        className="focus-ring mt-3 inline-flex h-8 items-center rounded-md bg-card px-3 text-sm font-medium text-foreground shadow-control hover:bg-muted"
      >
        Try again
      </button>
    </div>
  );
}
