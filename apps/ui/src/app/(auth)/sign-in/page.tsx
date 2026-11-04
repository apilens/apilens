import type { Metadata } from "next";
import { SignIn } from "@/components/onboarding/sign-in";
import { oauthStartLinks } from "@/lib/oauth";
import { safeNext } from "@/lib/safe-next";
import { signInNotice } from "@/lib/sign-in-notice";
import { signInMethods } from "@/lib/sign-in-providers";

export const metadata: Metadata = { title: "Sign in" };

type Query = { next?: string | string[]; error?: string | string[]; reason?: string | string[] };

export default async function Page({ searchParams }: { searchParams: Promise<Query> }) {
  const { next, error, reason } = await searchParams;
  const methods = await signInMethods();
  const target = safeNext(next, "") || undefined;
  return (
    <SignIn
      methods={methods}
      oauth={oauthStartLinks(methods, target)}
      next={target}
      notice={signInNotice({ error, reason })}
    />
  );
}
