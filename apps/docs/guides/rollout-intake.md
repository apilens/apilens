---
title: "Rollout intake template"
description: "Phase 0 of a third-party rollout: the facts to collect about a service before adding the APILens SDK to it."
---

Copy this template into the target repository (or the ticket tracking the rollout) and fill it in **before** writing any code. Every later phase of the rollout reads from it: the framework picks the setup guide, the data classification picks the capture posture, the endpoint inventory seeds the [redaction manifest](/guides/redaction-manifest), and peak RPS sizes the delivery queue.

Leave nothing blank. If a value is unknown, write `unknown` and who will answer it. An unknown classification means the service starts in the most restrictive posture.

---

## 1. Service

| Field | Value |
|---|---|
| Service name | |
| Repository URL | |
| Owning team / contact | |
| Rollout owner (who is making the change) | |
| APILens project | |
| APILens app ID(s) | |
| Environments to instrument | e.g. `staging`, `production` |
| Intake completed on | |

## 2. Framework and runtime

| Field | Value |
|---|---|
| Language and version | e.g. Python 3.12, Node 22, Java 21 |
| Web framework and version | e.g. FastAPI 0.115, Django 5.1, Express 5, Spring Boot 3.3 |
| Server / entrypoint | e.g. uvicorn, gunicorn with uvicorn workers, node cluster, Tomcat |
| Workers / processes per instance | |
| Existing middleware that touches request or response bodies | e.g. auth, gzip, body parsers |
| Existing tracing or APM agent | e.g. OpenTelemetry, Sentry, none |
| Matching setup guide | link from [Setup Guides](/setup-guides/fastapi) |

## 3. Deployment shape

Mark the shape that applies and fill in the details. The shape decides how the SDK flushes its queue on shutdown.

| Shape | Applies? | Details |
|---|---|---|
| Long-running containers / VMs | | instance count, autoscaling min and max |
| Kubernetes | | replicas, `terminationGracePeriodSeconds` |
| Serverless (Lambda, Cloud Run, Cloud Functions, ...) | | max concurrency, timeout, whether the runtime freezes between requests |
| Other | | |

| Field | Value |
|---|---|
| Graceful shutdown signal and grace period | e.g. SIGTERM, 30 s |
| Deploy / release mechanism | e.g. Argo CD, GitHub Actions, manual |
| Canary or staged rollout available? | yes / no, and how |
| Config system for the kill switch | e.g. env var, feature-flag service, ConfigMap |

## 4. Network egress

The SDK sends batches over HTTPS to the ingest endpoint. Confirm the service can reach it before rollout day.

| Field | Value |
|---|---|
| Ingest URL | e.g. `https://ingest.apilens.ai` or your self-hosted ingest host |
| Outbound internet allowed? | yes / no / allow-list only |
| Egress proxy | none, or the `HTTPS_PROXY` value |
| Firewall / allow-list change needed? | ticket link |
| Custom CA bundle required? | yes / no, and its path |
| Data residency constraint | e.g. EU only |

## 5. Data classification

Pick the highest class of data that passes through **any** endpoint of this service. It sets the starting capture posture in the rollout guide.

| Class | Examples | Applies? |
|---|---|---|
| Public | catalogue data, health checks | |
| Internal | internal IDs, feature flags | |
| Personal data (PII) | names, emails, phone numbers, addresses, IP addresses | |
| Sensitive / regulated | payment card data (PCI), health data, government IDs, credentials | |

| Field | Value |
|---|---|
| Highest class | |
| Applicable regimes | e.g. GDPR, PCI DSS, HIPAA, none |
| Data protection / security reviewer | |
| Client IP may be stored? | yes / truncated / no |
| Request and response bodies may be stored? | yes / redacted only / no |

## 6. Endpoint inventory

List every route the service exposes, using the framework's **route template** (the form APILens groups endpoints by), not concrete URLs. Tag each route with the PII it carries in the path, query string, headers, request body or response body. Mark routes you will exclude entirely (health checks, metrics, webhooks carrying secrets) in the last column.

PII tags: `none`, `email`, `name`, `phone`, `address`, `ip`, `dob`, `gov-id`, `card`, `bank`, `health`, `credential`, `token`, `free-text`, `other` (describe it).

| Method | Route template | Where PII appears | PII tags | Classification | Exclude? |
|---|---|---|---|---|---|
| `GET` | `/healthz` | none | `none` | Public | yes |
| `POST` | `/users` | req body, resp body | `email`, `name`, `phone` | Personal data | no |
| `GET` | `/users/{id}` | resp body | `email`, `name` | Personal data | no |
| | | | | | |

Source of the inventory, so it can be re-checked later: e.g. the OpenAPI spec path, `python manage.py show_urls`, or the router files.

## 7. Traffic and sizing

| Field | Value |
|---|---|
| Average requests per second (per instance) | |
| **Peak requests per second (per instance)** | |
| Peak requests per second (whole service) | |
| Typical request body size | |
| Typical response body size | |
| Largest bodies (endpoint and size) | e.g. file uploads, exports |
| Memory headroom per instance | |
| Acceptable added latency | e.g. none on the request path |

## 8. Sign-off

| Role | Name | Date |
|---|---|---|
| Service owner | | |
| Data protection / security | | |
| Rollout owner | | |
