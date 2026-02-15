"use client";

import { Radio } from "lucide-react";
import PageHeader from "@/components/dashboard/PageHeader";

export default function MonitorsPage() {
  return (
    <div className="placeholder-page">
      <PageHeader title="Monitors" description="Coming soon. Uptime monitoring and alerts will appear here." />
      <div className="placeholder-icon">
        <Radio size={32} />
      </div>
    </div>
  );
}
