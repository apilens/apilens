import { redirect } from "next/navigation";
import { getContext, getSession } from "@/lib/auth/server";
import { SIGN_IN_PATH } from "@/lib/auth-gate";
import { landingFor } from "@/lib/landing";

// `/` routes by session state (#310): signed out → sign-in; signed in without an organization →
// onboarding (at the stored step); otherwise → the last project on the preferred home view.
export default async function Home() {
  const session = await getSession();
  if (!session.payload) redirect(SIGN_IN_PATH);
  redirect(landingFor(await getContext("/")));
}
