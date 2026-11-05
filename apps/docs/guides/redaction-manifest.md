---
title: "Redaction manifest template"
description: "Phase 3 of a third-party rollout: every sensitive field in a service, the pattern that masks it, and the source file that defines it."
---

The redaction manifest is the reviewable record of **what** the SDK must mask in one service and **why**. Build it from the endpoint inventory in the [rollout intake](/guides/rollout-intake): every route tagged with PII there needs at least one row here, or an explicit exclusion.

Copy this template into the target repository next to the SDK configuration and keep it in version control. Whoever adds a field that carries PII adds its row here in the same change.

---

## How to fill it in

1. **Field**: the exact query parameter, header, or JSON body field name as it appears on the wire. For nested JSON, use the leaf name, since masking matches by name.
2. **Location**: where the field appears: `query`, `header`, `req body`, `resp body`, or `path`.
3. **Pattern**: the regex added to the SDK option for that location (`redact_query_params`, `redact_headers` or `redact_body_fields`). Patterns are matched case-insensitively and unanchored against the field **name**. Write `default` when a [built-in pattern](/getting-started/data-privacy#default-masking-patterns) already covers the field.
4. **Source file**: the file, and the symbol or line, in the service that defines the field (a serializer, schema, DTO or route handler), so a reviewer can verify it.
5. **PII tag**: the tag from the intake inventory (`email`, `card`, `token`, ...).
6. **Verified**: the date the field was confirmed masked in captured data.

Values in the URL path itself (for example an email in `/users/{email}`) cannot be masked by name. Record them with location `path` and resolve them by excluding the route or changing it.

## Manifest

| Field | Location | Pattern | Source file | PII tag | Verified |
|---|---|---|---|---|---|
| `password` | req body | `default` | `app/schemas/auth.py` `LoginRequest` | `credential` | |
| `email` | req body, resp body | `^email$` | `app/schemas/users.py` `UserCreate`, `UserOut` | `email` | |
| `phone_number` | req body | `phone` | `app/schemas/users.py` `UserCreate` | `phone` | |
| `x-customer-id` | header | `x-customer-id` | `app/middleware/tenant.py` | `other` | |
| `iban` | req body | `iban` | `app/schemas/payouts.py` `PayoutRequest` | `bank` | |
| | | | | | |

## Exclusions

Routes that are dropped entirely instead of masked, such as webhooks carrying secrets or routes with PII in the path.

| Method | Route template | Reason | Exclusion regex |
|---|---|---|---|
| `GET` | `/healthz` | no diagnostic value, high volume | `^/healthz$` |
| | | | |

## Resulting configuration

Collect the patterns above into the SDK options, and keep this block in sync with the tables.

```python
redact_query_params = []
redact_headers = [r"x-customer-id"]
redact_body_fields = [r"^email$", r"phone", r"iban"]
exclude_paths = [r"^/healthz$"]
```

## Review

| Reviewer | Date | Notes |
|---|---|---|
| | | |
