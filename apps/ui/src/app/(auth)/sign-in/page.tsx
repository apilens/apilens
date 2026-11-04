import type { Metadata } from "next";
import { SignIn } from "@/components/onboarding/sign-in";
import { safeNext } from "@/lib/safe-next";
import { signInMethods } from "@/lib/sign-in-providers";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <SignIn methods={await signInMethods()} next={safeNext(next, "") || undefined} />;
}
