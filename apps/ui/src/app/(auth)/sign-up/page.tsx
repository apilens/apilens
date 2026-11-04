import type { Metadata } from "next";
import { SignUp } from "@/components/onboarding/sign-up";
import { oauthStartLinks } from "@/lib/oauth";
import { safeNext } from "@/lib/safe-next";
import { signInMethods } from "@/lib/sign-in-providers";

export const metadata: Metadata = { title: "Create your account" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { next } = await searchParams;
  const target = safeNext(next, "") || undefined;
  const methods = await signInMethods();
  return <SignUp methods={methods} oauth={oauthStartLinks(methods, target)} next={target} />;
}
