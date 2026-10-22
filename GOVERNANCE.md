# Governance

This document describes how the APILens project is run and how decisions are
made. It will evolve as the contributor community grows.

## Roles

**Users** run APILens or its SDKs. They help by filing issues, answering
questions and sharing feedback.

**Contributors** submit issues, documentation, code or reviews. Anyone can
become a contributor; see [CONTRIBUTING.md](CONTRIBUTING.md).

**Maintainers** (listed in [MAINTAINERS.md](MAINTAINERS.md)) review and merge
changes, triage issues, cut releases, handle security reports and steward the
project's direction. Maintainers are expected to:

- review pull requests in their areas in a timely manner,
- follow and enforce the [Code of Conduct](CODE_OF_CONDUCT.md),
- uphold the project's open-source commitment: the core platform and every
  component a self-hoster needs stay under the MIT license.

### Becoming a maintainer

Contributors who have made sustained, high-quality contributions (code,
reviews, docs or community support) may be nominated by an existing
maintainer. A nomination is accepted by lazy consensus of the current
maintainers (see below) with at least one explicit approval and no objection
within 7 days. Maintainers who are inactive for 6 months may be moved to
emeritus status by the same process; emeritus maintainers can return by
asking.

## Decision making

Most decisions happen in pull requests and issues through **lazy consensus**:
a proposal is accepted if, after reasonable time for review (at least 72 hours
for non-trivial changes), no maintainer objects. Objections must come with a
reason and ideally an alternative.

### Architecture Decision Records

Significant technical decisions — new services or roles, datastores,
dependencies with license or security implications, public API or wire-format
changes, and changes to the security model — are recorded as **Architecture
Decision Records (ADRs)** in [`docs/adr/`](docs/adr/).

1. Copy the ADR template, number it sequentially and open a PR with status
   `Proposed`.
2. Discussion happens on the PR. The ADR is accepted by lazy consensus of the
   maintainers (minimum 7 days open for significant changes).
3. On merge the status becomes `Accepted`. Superseded ADRs are kept and marked
   `Superseded by ADR-NNNN`, never deleted.

### When consensus fails

If maintainers cannot reach consensus, the question is decided by a simple
majority vote of the maintainers. While the project has a single maintainer,
that maintainer decides after considering community input.

## Releases

Releases are automated with release-please from Conventional Commit titles.
Any maintainer may merge a release PR. Security releases follow
[SECURITY.md](SECURITY.md).

## Changes to this document

Changes to governance require a pull request approved by a majority of the
maintainers.
