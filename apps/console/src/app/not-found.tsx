import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-2 px-6">
      <p className="font-mono text-xs text-subtle-foreground">404</p>
      <h1 className="text-xl font-semibold text-foreground">This page does not exist</h1>
      <p className="text-sm text-muted-foreground">The link may be out of date.</p>
      <Link href="/traffic" className="focus-ring mt-2 self-start rounded-sm text-sm text-brand-text underline-offset-4 hover:underline">
        Go to traffic
      </Link>
    </main>
  );
}
