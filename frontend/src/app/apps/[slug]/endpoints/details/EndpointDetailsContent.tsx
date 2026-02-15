"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { EndpointDetail, EndpointPayloadSample } from "@/lib/api-client";

interface EndpointDetailsContentProps {
  appSlug: string;
}

const RANGES = [
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
] as const;

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function renderConsumer(call: EndpointPayloadSample): string {
  const name = (call.consumer_name || "").trim();
  if (name) return name;
  const identifier = (call.consumer_id || "").trim();
  if (identifier) return identifier;
  const ua = (call.user_agent || "").trim();
  if (ua) return ua;
  const ip = (call.ip_address || "").trim();
  return ip ? `IP ${ip}` : "Unknown consumer";
}

function previewPayload(payload: string): string {
  const value = (payload || "").trim();
  if (!value) return "(empty)";
  return value.length > 160 ? `${value.slice(0, 160)}...` : value;
}

export default function EndpointDetailsContent({ appSlug }: EndpointDetailsContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const method = searchParams.get("method") || "GET";
  const path = searchParams.get("path") || "/";
  const environment = searchParams.get("environment") || "";
  const sinceParam = searchParams.get("since");
  const untilParam = searchParams.get("until");

  const [rangeHours, setRangeHours] = useState(24);
  const [usePinnedWindow, setUsePinnedWindow] = useState(Boolean(sinceParam));
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [calls, setCalls] = useState<EndpointPayloadSample[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setUsePinnedWindow(Boolean(sinceParam));
  }, [sinceParam]);

  useEffect(() => {
    if (!sinceParam) return;
    const sinceMs = new Date(sinceParam).getTime();
    const untilMs = untilParam ? new Date(untilParam).getTime() : Date.now();
    if (Number.isNaN(sinceMs) || Number.isNaN(untilMs) || untilMs <= sinceMs) return;
    const hours = Math.max(1, Math.round((untilMs - sinceMs) / (1000 * 60 * 60)));
    setRangeHours(hours);
  }, [sinceParam, untilParam]);

  useEffect(() => {
    const fetchJson = async <T,>(url: string): Promise<T | null> => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      } finally {
        window.clearTimeout(timeout);
      }
    };

    async function load() {
      setLoading(true);
      try {
        const since = usePinnedWindow && sinceParam
          ? sinceParam
          : new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();
        const until = usePinnedWindow ? (untilParam || "") : "";
        const qs = new URLSearchParams();
        qs.set("method", method);
        qs.set("path", path);
        qs.set("since", since);
        if (until) qs.set("until", until);
        if (environment) qs.set("environment", environment);
        const common = qs.toString();

        const detailData = await fetchJson<EndpointDetail>(`/api/apps/${appSlug}/analytics/endpoint-detail?${common}`);
        setDetail(
          detailData || {
            method,
            path,
            total_requests: 0,
            error_count: 0,
            error_rate: 0,
            avg_response_time_ms: 0,
            p95_response_time_ms: 0,
            total_request_bytes: 0,
            total_response_bytes: 0,
            last_seen_at: null,
          },
        );

        const callData = await fetchJson<EndpointPayloadSample[]>(`/api/apps/${appSlug}/analytics/endpoint-payloads?${common}&limit=100`);
        setCalls(callData || []);
        setSelectedIndex(0);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [appSlug, environment, method, path, rangeHours, sinceParam, untilParam, usePinnedWindow]);

  const selectedCall = calls[selectedIndex] || null;
  const requestsPerMin = useMemo(
    () => (detail?.total_requests || 0) / Math.max(1, rangeHours * 60),
    [detail?.total_requests, rangeHours],
  );

  if (loading && !detail) {
    return <div className="endpoint-details-loading">Loading endpoint details...</div>;
  }

  return (
    <div className="endpoint-details-page">
      <div className="endpoint-details-topbar">
        <button type="button" className="endpoint-back-btn" onClick={() => router.push(`/apps/${appSlug}/endpoints`)}>
          Back to Endpoints
        </button>
        {environment && <span className="endpoint-details-env-chip">Env: {environment}</span>}
        <div className="endpoint-details-range">
          {RANGES.map((r) => (
            <button
              key={r.hours}
              type="button"
              className={`endpoint-details-range-btn${rangeHours === r.hours ? " active" : ""}`}
              onClick={() => {
                setUsePinnedWindow(false);
                setRangeHours(r.hours);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="endpoint-details-head">
        <span className={`method-badge method-badge-${method.toLowerCase()}`}>{method}</span>
        <h2>{path}</h2>
      </div>

      <div className="endpoint-details-summary-grid endpoint-details-summary-grid-4">
        <div className="endpoint-summary-card"><p>Total requests</p><strong>{fmtNum(detail?.total_requests || 0)}</strong></div>
        <div className="endpoint-summary-card"><p>Requests / min</p><strong>{requestsPerMin.toFixed(2)}</strong></div>
        <div className="endpoint-summary-card"><p>Error rate</p><strong>{detail?.error_rate?.toFixed(1) || 0}%</strong></div>
        <div className="endpoint-summary-card"><p>P95 latency</p><strong>{detail?.p95_response_time_ms?.toFixed(0) || 0} ms</strong></div>
      </div>

      <div className="endpoint-details-panels endpoint-details-panels-main endpoint-calls-layout">
        <section className="endpoint-panel endpoint-calls-list-panel">
          <h3>Individual API calls</h3>
          <div className="endpoint-calls-list">
            {calls.map((call, idx) => {
              const selected = idx === selectedIndex;
              return (
                <button
                  key={`${call.timestamp}-${idx}`}
                  type="button"
                  className={`endpoint-call-row${selected ? " active" : ""}`}
                  onClick={() => setSelectedIndex(idx)}
                >
                  <div className="endpoint-call-row-top">
                    <span className="endpoint-call-status">{call.status_code}</span>
                    <span className="endpoint-call-time">{new Date(call.timestamp).toLocaleString()}</span>
                  </div>
                  <p className="endpoint-call-consumer">{renderConsumer(call)}</p>
                  <p className="endpoint-call-preview">{previewPayload(call.request_payload)}</p>
                </button>
              );
            })}
            {calls.length === 0 && <p className="endpoint-empty-note">No calls found in this range.</p>}
          </div>
        </section>

        <section className="endpoint-panel endpoint-call-detail-panel">
          <h3>Call details</h3>
          {selectedCall ? (
            <div className="endpoint-call-detail-content">
              <div className="endpoint-call-meta-grid">
                <div><p>Status</p><strong>{selectedCall.status_code}</strong></div>
                <div><p>Latency</p><strong>{selectedCall.response_time_ms?.toFixed(1) || "0.0"} ms</strong></div>
                <div><p>Consumer</p><strong>{renderConsumer(selectedCall)}</strong></div>
                <div><p>Consumer group</p><strong>{selectedCall.consumer_group || "-"}</strong></div>
                <div><p>Method</p><strong>{selectedCall.method}</strong></div>
                <div><p>Path</p><strong>{selectedCall.path}</strong></div>
              </div>
              <div className="endpoint-payload-block">
                <p>Request payload</p>
                <pre>{selectedCall.request_payload || "(empty)"}</pre>
              </div>
              <div className="endpoint-payload-block">
                <p>Response payload</p>
                <pre>{selectedCall.response_payload || "(empty)"}</pre>
              </div>
            </div>
          ) : (
            <p className="endpoint-empty-note">Select a call to inspect payload and response.</p>
          )}
        </section>
      </div>
    </div>
  );
}
