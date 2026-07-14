"use client";

import { Activity } from "lucide-react";

export default function DashboardContent() {
  return (
    <>
      <div className="mb-8">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Monitor your API performance, health and latency</p>
      </div>

      <div className="flex flex-col items-center justify-center px-6 py-16 text-center text-muted-foreground">
        <Activity className="mb-4 size-12 text-muted-foreground" />
        <h3 className="mb-1 text-4xl font-medium text-foreground">Welcome to ApiLens</h3>
        {/*<p className="max-w-xs text-sm text-muted-foreground">*/}
        {/*  Your API monitoring dashboard will appear here. Start by adding your first API endpoint.*/}
        {/*</p>*/}
      </div>
    </>
  );
}
