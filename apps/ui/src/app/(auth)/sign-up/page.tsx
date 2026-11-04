import type { Metadata } from "next";
import { SignUp } from "@/components/onboarding/sign-up";
import { signInMethods } from "@/lib/sign-in-providers";

export const metadata: Metadata = { title: "Create your account" };

export default async function Page() {
  return <SignUp methods={await signInMethods()} />;
}
