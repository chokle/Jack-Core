---
name: Playwright browser install fails in this Nix Replit env
description: npx playwright install (with or without --with-deps) cannot install Chromium here because the underlying apt-based system-dependency installer is blocked on Nix-based Replit.
---

# Ad-hoc Playwright/Chromium installs don't work here

Running `npx -y playwright@<version> install chromium` (or `--with-deps`) fails with
"Failed to install browsers" because Playwright's installer shells out to
`apt`/`sudo` to fetch OS-level dependencies, and that path is blocked on
Replit's Nix-based environment ("Tools like apt, brew, and yum ... are not
directly callable inside Replit").

**Why:** this isn't a flaky network issue or a version mismatch — it's a
structural mismatch between Playwright's Debian-oriented installer and the
Nix package manager. Retrying with a different Playwright version or adding
`--with-deps` does not change the outcome.

**How to apply:** don't spend more than one attempt confirming this. When a
task calls for a live end-to-end browser pass and no test runner/browser is
already provisioned in the workspace, fall back to a careful code-trace
verification (trace the exact event handlers/props/effects the automation
would exercise) plus `pnpm run typecheck`, and say so explicitly in the
task report rather than reporting a live pass that didn't happen. If genuine
in-browser E2E is required, that needs a pre-provisioned test workflow/blueprint,
not an ad-hoc npx install.
