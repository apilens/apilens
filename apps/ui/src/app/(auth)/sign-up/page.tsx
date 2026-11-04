import type { Metadata } from "next";
import { SignUp } from "@/components/onboarding/sign-up";
import { safeNext } from "@/lib/safe-next";
import { signInMethods } from "@/lib/sign-in-providers";

export const metadata: Metadata = { title: "Create your account" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { next } = await searchParams;
  const target = safeNext(next, "");
  return <SignUp methods={await signInMethods()} next={target || undefined} />;
}
