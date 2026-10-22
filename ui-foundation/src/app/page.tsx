import Link from "next/link";

import { ArrowRightIcon, BookOpenIcon, SquaresFourIcon } from "@/components/ui/icon";
import { Panel } from "@/components/ui/panel";

const LINKS = [
  {
    href: "/design",
    icon: BookOpenIcon,
    title: "Design reference",
    body: "Every token, primitive and pattern in every state. The page agents compare their work against.",
  },
  {
    href: "/projects/checkout-api",
    icon: SquaresFourIcon,
    title: "Demo app",
    body: "Overview and settings built only from the foundation. Try partner-sync for the view-only role.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <h1 className="text-xl font-semibold text-foreground">Aperture foundation</h1>
      <p className="mt-2 text-base text-muted-foreground">The UI system for APILens: tokens, primitives, patterns and the rules agents follow.</p>
      <Panel className="mt-8">
        <div className="divide-y divide-border">
        {LINKS.map(({ href, icon: Icon, title, body }) => (
          <Link key={href} href={href} className="focus-ring group flex items-start gap-3 px-4 py-4 transition-colors duration-100 first:rounded-t-lg last:rounded-b-lg hover:bg-muted">
            <Icon className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{title}</span>
              <span className="block text-sm text-muted-foreground">{body}</span>
            </span>
            <ArrowRightIcon className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
          </Link>
        ))}
        </div>
      </Panel>
    </main>
  );
}
