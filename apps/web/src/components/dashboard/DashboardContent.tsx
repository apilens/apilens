"use client";

import { Activity } from "lucide-react";

export default function DashboardContent() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-description">Monitor your API performance, health and latency</p>
      </div>

      <div className="empty-state">
        <Activity className="empty-state-icon" />
        <h3 className="empty-state-title">Welcome to ApiLens</h3>
        {/*<p className="empty-state-description">*/}
        {/*  Your API monitoring dashboard will appear here. Start by adding your first API endpoint.*/}
        {/*</p>*/}
      </div>
    </>
  );
}
