import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  redirect("/account/general");
}
