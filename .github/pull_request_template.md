<!--
PR titles must follow Conventional Commits — they become the squash-merge
commit and drive release notes, e.g. `feat(ingest): accept OTLP logs`.
-->

## Summary

<!-- What does this change and why? Link issues with "Closes #123". -->

## How was this tested?

<!-- Commands you ran (task test, task test:integration, task test:e2e, …) and what you checked manually. -->

## Checklist

- [ ] The PR title follows [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] Every commit is signed off (`git commit -s`) per the [DCO](https://developercertificate.org/).
- [ ] Tests were added or updated, and `task lint test` passes locally.
- [ ] Generated code is up to date (`task gen` leaves no diff).
- [ ] Docs / ADRs were updated for user-facing or architectural changes.
- [ ] No secrets, API keys or personal data are included.
