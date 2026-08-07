# AGENTS.md — drift manifest for devportal-core

This repository is a fork of [redhat-developer/rhdh](https://github.com/redhat-developer/rhdh),
maintained as the product base for **VeeCode DevPortal**. Planning, tickets, and
mission conventions live in [veecode-platform/devportal-planning](https://github.com/veecode-platform/devportal-planning)
(private) — read that repo's `AGENTS.md` for the full mission context before
making structural changes here.

## Branch layout

- `main` — upstream mirror. Never receives our commits directly; only the
  weekly sync workflow writes to it (fast-forward from `upstream/main`).
- `veecode/main` — **default branch**. Our drift over upstream `main` lives
  here. All feature work and PRs target this branch.
- `veecode/release-1.10` — stable production line, tracks upstream
  `release-1.10`.

## The additive-first rule

Prefer new files over edits to files that exist upstream. New files never
conflict during the weekly upstream merge; edits to existing upstream files
do, and every such edit becomes drift that a human or sync agent must
reconcile by hand.

If a change to an upstream file is unavoidable, keep it as small and
localized as possible, and add it to the manifest below in the same PR.

## Drift manifest

Every file this fork adds or modifies relative to upstream must be listed
here. **A change that is not in this manifest is a change the sync agent is
allowed to lose** on the next upstream merge.

| Path | Type | Purpose |
|---|---|---|
| `.github/workflows/upstream-sync.yaml` | added | Weekly automated merge from `upstream/main` → `veecode/main` and `upstream/release-1.10` → `veecode/release-1.10`; opens an issue on conflict. |
| `.github/workflows/secret-scan.yaml` | added | Runs gitleaks on push and pull_request against `veecode/**` branches. |
| `AGENTS.md` (this file) | added | Drift manifest and fork conventions. |

Upstream files modified: **none**.

Every PR that introduces drift (a new file under our control, or an edit to
an upstream file) must update this table in the same PR.

## Documented deviations from the M0 spec

- **Sync-conflict issue destination**: the M0 spec calls for the conflict
  issue to be opened in `devportal-planning` (private) so it lands next to
  the planning tracker. That cross-repo write would require provisioning a
  PAT secret in this public fork solely to file issues in a private repo,
  which is disproportionate for M0. Instead, `upstream-sync.yaml` opens the
  conflict issue **in this repository** (`devportal-core`), titled
  `upstream sync conflict: <branch>`, listing the conflicting files and
  pointing back to this manifest. Revisit if/when a scoped bot token for
  cross-repo issue creation is provisioned.

## Secret scanning

GitHub secret scanning + push protection are expected to be enabled on this
repo (free on public repos). `secret-scan.yaml` adds gitleaks as a
defense-in-depth layer. See devportal-planning's mission rules: no
production configuration ever lands in this public repo.
