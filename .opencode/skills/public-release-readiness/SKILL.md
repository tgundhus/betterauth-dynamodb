---
name: public-release-readiness
description: Use when preparing this package for public release, npm publication, README/package metadata review, licensing notes, contribution docs, or repository hygiene.
---

# Public release readiness workflow

Use this skill for docs, package metadata, and publication-readiness work. Do not invent project decisions.

## Review steps

1. Inspect `package.json`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `.gitignore`, and CI before editing.
2. Keep installation wording honest until the package is actually published. Prefer local/path or future-publication wording over implying npm availability.
3. Remove or avoid nonexistent repository URLs, package URLs, security contacts, maintainers, or governance claims.
4. State licensing status accurately. Add a `LICENSE` only after the project owner has selected a license.
5. Confirm public examples contain no secrets, private AWS account details, or sibling-repo dependencies. Document Hub-style examples may show `Resource.*` and SST patterns but package code must remain standalone.
6. Keep quality policy visible: `bun run verify`, coverage thresholds, and per-production-function CRAP <= 6.
7. Run `bun run verify` after docs/config changes when feasible, because docs must not undermine existing guarantees.

## Handoff notes

Report files changed, publication blockers, verification results including max CRAP, and remind the user to restart opencode after skill/config changes.
