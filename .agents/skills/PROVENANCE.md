# Skill Provenance / Adoption Notes

## Policy
The approved 20-skill shortlist was derived from publicly documented agent-engineering patterns and public skill ecosystems, including Anthropic Agent Skills, OpenClaw/ClawHub-style skill discovery, Superpowers-style development workflows, multi-agent/context-engineering collections, and established software-engineering practice.

This repository version is an independent, compact implementation of the approved behavior patterns. No third-party skill source has been copied verbatim into this branch.

Before vendoring any external source code or complete third-party skill text later, Surveyor must record:
- exact repository/package and commit/version;
- licence and compatibility;
- files/text copied or adapted;
- security/dependency review;
- reason existing repository-local skill is insufficient.

## Rejected/trimmed behavior
- No skill may self-promote into production without review.
- No autonomous merge/deploy/production mutation is granted by these skills.
- No unbounded recursive agent spawning.
- No blind installation from public registries.
- No generic MCP construction when an existing approved connector already satisfies the need.
- No TDD dogma where live/runtime verification is the actual acceptance gate.
- No context compression that drops safety, licensing, privacy, founder decisions, or provenance.

These constraints intentionally remove the risky/weird parts while retaining the useful engineering patterns.
