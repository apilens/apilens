#!/bin/bash

# APILens Roadmap Project Setup Script
# This script creates a GitHub Project and populates it with roadmap issues

set -e

REPO="apilens/apilens"
PROJECT_TITLE="APILens Product Roadmap 2026"

echo "🚀 Setting up APILens Product Roadmap..."
echo ""

# Check if gh is authenticated
if ! gh auth status &> /dev/null; then
    echo "❌ Error: GitHub CLI is not authenticated"
    echo "Please run: gh auth login"
    exit 1
fi

# Refresh auth with project scopes
echo "📝 Refreshing GitHub auth with project scopes..."
gh auth refresh -s project,read:project,write:org -h github.com

echo ""
echo "📊 Creating GitHub Project..."

# Create the project (v2)
PROJECT_URL=$(gh project create \
    --owner apilens \
    --title "$PROJECT_TITLE" \
    --format json | jq -r '.url')

PROJECT_NUMBER=$(echo $PROJECT_URL | grep -oE '[0-9]+$')

echo "✅ Project created: $PROJECT_URL"
echo ""

# Extract project ID for adding items
PROJECT_ID=$(gh api graphql -f query='
  query($org: String!, $number: Int!) {
    organization(login: $org){
      projectV2(number: $number) {
        id
      }
    }
  }' -f org='apilens' -F number=$PROJECT_NUMBER --jq '.data.organization.projectV2.id')

echo "Project ID: $PROJECT_ID"
echo ""

# Create labels for roadmap phases
echo "🏷️  Creating labels..."
gh label create "roadmap:phase-1" --repo $REPO --color "0E8A16" --description "Phase 1: Payload Monitoring" --force
gh label create "roadmap:phase-2" --repo $REPO --color "1D76DB" --description "Phase 2: API Versioning" --force
gh label create "roadmap:phase-3" --repo $REPO --color "5319E7" --description "Phase 3: Consumer Intelligence" --force
gh label create "priority:critical" --repo $REPO --color "D93F0B" --description "P0 - Critical priority" --force
gh label create "priority:high" --repo $REPO --color "FBCA04" --description "P1 - High priority" --force
gh label create "priority:medium" --repo $REPO --color "0075CA" --description "P2 - Medium priority" --force
gh label create "type:feature" --repo $REPO --color "A2EEEF" --description "New feature" --force

echo "✅ Labels created"
echo ""

# Function to create an issue and add it to the project
create_issue() {
    local title="$1"
    local body="$2"
    local labels="$3"
    local milestone="$4"

    echo "📝 Creating issue: $title"

    # Create the issue
    ISSUE_URL=$(gh issue create \
        --repo $REPO \
        --title "$title" \
        --body "$body" \
        --label "$labels" \
        --assignee "" | tail -n 1)

    ISSUE_NUMBER=$(echo $ISSUE_URL | grep -oE '[0-9]+$')

    # Get issue node ID
    ISSUE_ID=$(gh api graphql -f query='
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id
          }
        }
      }' -f owner='apilens' -f repo='apilens' -F number=$ISSUE_NUMBER --jq '.data.repository.issue.id')

    # Add issue to project
    gh api graphql -f query='
      mutation($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
          item {
            id
          }
        }
      }' -f project=$PROJECT_ID -f content=$ISSUE_ID > /dev/null

    echo "✅ Created and added to project: $ISSUE_URL"
}

echo "Creating Phase 1 issues..."
echo ""

# Phase 1.1: Request/Response Payload Capture
create_issue \
    "[PHASE 1.1] Request/Response Payload Capture" \
    "## 📦 Feature Overview

**Phase**: Phase 1 - Payload Monitoring & Deep Inspection
**Target Quarter**: Q2 2026 (Apr - Jun)
**Priority**: P0 (Critical)
**Estimated Effort**: 3 weeks

## 📝 Description

Implement comprehensive request/response payload capture and storage system with configurable sampling rates and automatic PII redaction.

## 🎯 Goals & Success Metrics

- [ ] Capture request/response payloads for all API calls
- [ ] Implement configurable sampling rates (1%, 10%, 50%, 100%)
- [ ] Auto-capture all 4xx/5xx error responses
- [ ] Detect and redact PII automatically
- [ ] Support payload size limits (default: 100KB)

**Key Metrics**:
- 90%+ payload capture rate with <5ms latency overhead
- Zero PII leaks in captured payloads
- 10:1 compression ratio for storage

## 🔧 Technical Requirements

### Backend Changes
- [ ] Create \`request_payloads\` and \`response_payloads\` ClickHouse tables
- [ ] Implement payload capture middleware in SDK
- [ ] Build PII detection service using regex + ML
- [ ] Add payload compression (gzip/zstd)
- [ ] Create sampling configuration API

### Frontend Changes
- [ ] Payload viewer component with JSON syntax highlighting
- [ ] Sampling rate configuration UI
- [ ] PII redaction settings panel

### Infrastructure
- [ ] ClickHouse storage with TTL policies
- [ ] S3/GCS for archival (>90 days)
- [ ] Estimated storage: 10TB/month for high-traffic apps

## 📋 Files to Create/Modify

**Backend**:
- \`backend/apps/payloads/\` (new app)
- \`backend/apps/payloads/models.py\`
- \`backend/apps/payloads/services.py\`
- \`backend/apps/payloads/clickhouse_schema.sql\`
- \`backend/core/middleware/payload_capture.py\`

**Frontend**:
- \`frontend/src/components/payloads/PayloadViewer.tsx\`
- \`frontend/src/app/apps/[slug]/payloads/page.tsx\`

## 🔗 Related Issues

- Depends on: Infrastructure capacity planning
- Blocks: #[Phase 1.2], #[Phase 1.4]

## 💡 Open Questions

1. Should we support binary payloads (images, PDFs)?
2. What's the max payload size we should support?
3. How do we handle streaming responses?

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-1,priority:critical,type:feature"

# Phase 1.2: Payload Search & Filtering
create_issue \
    "[PHASE 1.2] Payload Search & Filtering" \
    "## 📦 Feature Overview

**Phase**: Phase 1 - Payload Monitoring & Deep Inspection
**Target Quarter**: Q2 2026
**Priority**: P0 (Critical)
**Estimated Effort**: 2 weeks

## 📝 Description

Enable full-text search and advanced filtering across captured request/response payloads using JSONPath queries and schema validation.

## 🎯 Goals & Success Metrics

- [ ] Full-text search across all payloads
- [ ] JSONPath query support (\`$.user.email\`)
- [ ] Filter by payload fields and values
- [ ] Schema validation error highlighting
- [ ] Advanced query builder UI

**Key Metrics**:
- Sub-second search across 100M+ payloads
- 95%+ query success rate
- Support 10K concurrent searches

## 🔧 Technical Requirements

### Backend Changes
- [ ] ClickHouse full-text search indexes
- [ ] JSONPath query parser
- [ ] Schema validation engine
- [ ] Search API with pagination

### Frontend Changes
- [ ] Advanced search UI with query builder
- [ ] JSONPath autocomplete
- [ ] Search results table with highlighting

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-1,priority:critical,type:feature"

# Phase 1.3: Payload Analytics Dashboard
create_issue \
    "[PHASE 1.3] Payload Analytics Dashboard" \
    "## 📦 Feature Overview

**Phase**: Phase 1 - Payload Monitoring & Deep Inspection
**Target Quarter**: Q2 2026
**Priority**: P1 (High)
**Estimated Effort**: 2 weeks

## 📝 Description

Build comprehensive analytics dashboard showing payload size trends, common patterns, schema drift, and breaking changes.

## 🎯 Goals & Success Metrics

- [ ] Payload size trends over time
- [ ] Most common request/response patterns
- [ ] Schema drift detection
- [ ] Breaking change alerts
- [ ] Data type distribution analysis

**Key Metrics**:
- Detect 100% of schema changes
- Alert on breaking changes within 5 minutes
- Identify top 20 payload patterns

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-1,priority:high,type:feature"

# Phase 1.4: Payload Replay & Testing
create_issue \
    "[PHASE 1.4] Payload Replay & Testing" \
    "## 📦 Feature Overview

**Phase**: Phase 1 - Payload Monitoring & Deep Inspection
**Target Quarter**: Q2 2026
**Priority**: P1 (High)
**Estimated Effort**: 2 weeks

## 📝 Description

Enable one-click payload replay for debugging, with ability to modify and resend requests, compare results, and export as cURL/Postman.

## 🎯 Goals & Success Metrics

- [ ] One-click payload replay
- [ ] Modify and resend requests
- [ ] Before/after comparison view
- [ ] Export as cURL, Postman, HTTPie
- [ ] Generate test cases from real traffic

**Key Metrics**:
- 80%+ replay success rate
- Support 100% of HTTP methods
- Generate 10K+ test cases

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-1,priority:high,type:feature"

# Phase 1.5: PII & Security Scanner
create_issue \
    "[PHASE 1.5] PII & Security Scanner" \
    "## 📦 Feature Overview

**Phase**: Phase 1 - Payload Monitoring & Deep Inspection
**Target Quarter**: Q2 2026
**Priority**: P0 (Critical)
**Estimated Effort**: 1.5 weeks

## 📝 Description

Automatic detection of sensitive data (SSN, credit cards, emails) with configurable redaction rules and compliance reporting.

## 🎯 Goals & Success Metrics

- [ ] Detect SSN, credit cards, emails, IPs, tokens
- [ ] Configurable redaction rules
- [ ] GDPR/HIPAA/PCI-DSS compliance reports
- [ ] Alert on PII exposure
- [ ] Data retention policies per sensitivity

**Key Metrics**:
- 99.9%+ PII detection accuracy
- Zero false negatives for critical PII (SSN, CC)
- <10% false positive rate

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-1,priority:critical,type:feature"

echo ""
echo "Creating Phase 2 issues..."
echo ""

# Phase 2.1: Multi-Version Support
create_issue \
    "[PHASE 2.1] Multi-Version Support" \
    "## 📦 Feature Overview

**Phase**: Phase 2 - API Versioning & Lifecycle Management
**Target Quarter**: Q3 2026 (Jul - Sep)
**Priority**: P0 (Critical)
**Estimated Effort**: 3 weeks

## 📝 Description

Support semantic versioning (v1, v1.2.3, v2.0-beta) with version detection from URL, header, or query param, and per-version analytics.

## 🎯 Goals & Success Metrics

- [ ] Support semantic versioning
- [ ] Version detection (URL/header/query)
- [ ] Per-version analytics dashboards
- [ ] Version comparison views
- [ ] Default version configuration

**Key Metrics**:
- Track 100% of API versions
- Support 10+ concurrent versions per app
- <50ms version detection overhead

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-2,priority:critical,type:feature"

# Phase 2.2: Version Migration Dashboard
create_issue \
    "[PHASE 2.2] Version Migration Dashboard" \
    "## 📦 Feature Overview

**Phase**: Phase 2 - API Versioning & Lifecycle Management
**Target Quarter**: Q3 2026
**Priority**: P1 (High)
**Estimated Effort**: 2 weeks

## 📝 Description

Track consumer adoption per version with migration progress visualization and bulk migration tools.

## 🎯 Goals & Success Metrics

- [ ] Consumer adoption tracking per version
- [ ] Migration progress visualization
- [ ] Identify consumers on deprecated versions
- [ ] Bulk consumer migration tools
- [ ] Version sunset countdown

**Key Metrics**:
- 95%+ migration completion rate
- <30 day average migration time
- 100% consumer visibility

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-2,priority:high,type:feature"

# Phase 2.3: Breaking Change Detection
create_issue \
    "[PHASE 2.3] Breaking Change Detection" \
    "## 📦 Feature Overview

**Phase**: Phase 2 - API Versioning & Lifecycle Management
**Target Quarter**: Q3 2026
**Priority**: P1 (High)
**Estimated Effort**: 2.5 weeks

## 📝 Description

Automatic schema comparison between versions to highlight removed/renamed fields and detect response type changes.

## 🎯 Goals & Success Metrics

- [ ] Automatic schema comparison
- [ ] Highlight removed/renamed fields
- [ ] Detect response type changes
- [ ] Impact analysis (which consumers break)
- [ ] Generate migration guides

**Key Metrics**:
- Detect 100% of breaking changes
- <24hr notification time
- Zero undetected schema changes

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-2,priority:high,type:feature"

# Phase 2.4: Version Deprecation Workflow
create_issue \
    "[PHASE 2.4] Version Deprecation Workflow" \
    "## 📦 Feature Overview

**Phase**: Phase 2 - API Versioning & Lifecycle Management
**Target Quarter**: Q3 2026
**Priority**: P1 (High)
**Estimated Effort**: 1.5 weeks

## 📝 Description

Mark versions as deprecated with sunset dates, automated notifications, HTTP headers, and gradual traffic shifting.

## 🎯 Goals & Success Metrics

- [ ] Mark versions as deprecated
- [ ] Automated email notifications
- [ ] Return Deprecation/Sunset headers
- [ ] Gradual traffic shifting
- [ ] Force sunset enforcement

**Key Metrics**:
- 100% notification delivery
- 90%+ consumer acknowledgment
- Smooth sunset with zero downtime

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-2,priority:high,type:feature"

echo ""
echo "Creating Phase 3 issues..."
echo ""

# Phase 3.1: Enhanced Consumer Identification
create_issue \
    "[PHASE 3.1] Enhanced Consumer Identification" \
    "## 📦 Feature Overview

**Phase**: Phase 3 - Consumer Intelligence & Attribution
**Target Quarter**: Q4 2026 (Oct - Dec)
**Priority**: P0 (Critical)
**Estimated Effort**: 2.5 weeks

## 📝 Description

Multi-factor consumer ID (API key + IP + User-Agent + custom headers) with profiles, automatic discovery, and OAuth/JWT mapping.

## 🎯 Goals & Success Metrics

- [ ] Multi-factor consumer identification
- [ ] Consumer profiles with metadata
- [ ] Automatic consumer discovery
- [ ] OAuth/JWT user mapping
- [ ] Anonymous vs authenticated tracking

**Key Metrics**:
- Identify 100% of API consumers
- <100ms consumer resolution time
- 95%+ identification accuracy

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-3,priority:critical,type:feature"

# Phase 3.2: Consumer Analytics Dashboard
create_issue \
    "[PHASE 3.2] Consumer Analytics Dashboard" \
    "## 📦 Feature Overview

**Phase**: Phase 3 - Consumer Intelligence & Attribution
**Target Quarter**: Q4 2026
**Priority**: P0 (Critical)
**Estimated Effort**: 3 weeks

## 📝 Description

Per-consumer analytics showing request volume, errors, latency, health scores, and churn risk analysis.

## 🎯 Goals & Success Metrics

- [ ] Per-consumer request volume/errors/latency
- [ ] Top consumers by traffic/revenue
- [ ] Consumer health scores
- [ ] Usage trends and anomaly detection
- [ ] Churn risk analysis

**Key Metrics**:
- Track 100% of consumer activity
- 80%+ churn prediction accuracy
- Real-time dashboard updates

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-3,priority:critical,type:feature"

# Phase 3.3: Consumer Journey Mapping
create_issue \
    "[PHASE 3.3] Consumer Journey Mapping" \
    "## 📦 Feature Overview

**Phase**: Phase 3 - Consumer Intelligence & Attribution
**Target Quarter**: Q4 2026
**Priority**: P1 (High)
**Estimated Effort**: 2.5 weeks

## 📝 Description

Visualize API call sequences per consumer with session replay, funnel analysis, and drop-off detection.

## 🎯 Goals & Success Metrics

- [ ] Visualize API call sequences
- [ ] Session replay (timeline)
- [ ] Identify common usage patterns
- [ ] Funnel analysis
- [ ] Drop-off point detection

**Key Metrics**:
- Track 100% of consumer sessions
- Identify top 50 usage patterns
- 90%+ funnel accuracy

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-3,priority:high,type:feature"

# Phase 3.4: Consumer-to-API Call Attribution
create_issue \
    "[PHASE 3.4] Consumer-to-API Call Attribution" \
    "## 📦 Feature Overview

**Phase**: Phase 3 - Consumer Intelligence & Attribution
**Target Quarter**: Q4 2026
**Priority**: P0 (Critical)
**Estimated Effort**: 2 weeks

## 📝 Description

Drill down from consumer to individual API calls with filtering, error tracking, trace linking, and cost attribution.

## 🎯 Goals & Success Metrics

- [ ] Drill down to individual API calls
- [ ] Filter logs/payloads by consumer
- [ ] Consumer-specific error tracking
- [ ] Request trace linking
- [ ] Cost attribution per consumer

**Key Metrics**:
- 100% attribution accuracy
- <1 second drill-down query time
- Support 1M+ API calls per consumer

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-3,priority:critical,type:feature"

# Phase 3.5: Consumer Engagement Tools
create_issue \
    "[PHASE 3.5] Consumer Engagement Tools" \
    "## 📦 Feature Overview

**Phase**: Phase 3 - Consumer Intelligence & Attribution
**Target Quarter**: Q4 2026
**Priority**: P1 (High)
**Estimated Effort**: 2 weeks

## 📝 Description

Automated alerts to consumers on errors, in-app notifications for quota limits, tiered access controls, and usage-based billing.

## 🎯 Goals & Success Metrics

- [ ] Automated email/Slack alerts
- [ ] In-app quota notifications
- [ ] Consumer-specific rate limiting
- [ ] Tiered access controls
- [ ] Usage-based billing integration

**Key Metrics**:
- 99%+ alert delivery rate
- <5 minute alert latency
- 90%+ consumer satisfaction

See [ROADMAP.md](../ROADMAP.md) for full context." \
    "roadmap:phase-3,priority:high,type:feature"

echo ""
echo "✅ Roadmap setup complete!"
echo ""
echo "📊 Project URL: $PROJECT_URL"
echo "📋 View all issues: https://github.com/$REPO/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap"
echo ""
echo "Next steps:"
echo "1. Visit the project and customize views/fields"
echo "2. Assign issues to team members"
echo "3. Set milestones and due dates"
echo "4. Start implementation!"
echo ""
