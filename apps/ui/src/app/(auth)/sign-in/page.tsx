import type { Metadata } from "next";
import { SignIn } from "@/components/onboarding/sign-in";
import { signInMethods } from "@/lib/sign-in-providers";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page() {
  return <SignIn methods={await signInMethods()} />;
}
