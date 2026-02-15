"use client";

import { BarChart3 } from "lucide-react";
import PageHeader from "@/components/dashboard/PageHeader";

export default function AnalyticsPage() {
  return (
    <div className="placeholder-page">
      <PageHeader title="Analytics" description="Coming soon. Advanced analytics and breakdowns will appear here." />
      <div className="placeholder-icon">
        <BarChart3 size={32} />
      </div>
    </div>
  );
}
