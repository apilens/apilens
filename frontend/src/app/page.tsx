import { getSession } from "@/lib/session";
import { redirect } from "next/navigation";
import DashboardLayout from "@/components/dashboard/DashboardLayout";
import DashboardContent from "@/components/dashboard/DashboardContent";

export default async function Home() {
  const session = await getSession();

  if (!session) {
    redirect("/auth/login");
  }

  return (
    <DashboardLayout>
      <DashboardContent />
    </DashboardLayout>
  );
}
