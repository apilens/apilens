import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export default async function Settings() {
  const session = await getSession();

  if (!session) {
    redirect("/auth/login");
  }

  redirect("/settings/general");
}
