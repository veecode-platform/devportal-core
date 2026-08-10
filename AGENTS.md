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
| `.github/workflows/publish-edge.yaml` | added | `workflow_dispatch`-only build/publish channel for `docker.io/veecode/devportal` (M1). Lives on `veecode/release-1.10` (where it actually runs) **and** on `veecode/main` (required for GitHub to register a `workflow_dispatch` workflow at all — registration only happens from the default branch; see "Documented deviations from the M1 spec" below). Reuses `./.github/actions/get-sha` and `./.github/actions/docker-build` unmodified; drops the Quay tag-lifecycle logic from `next-build-image.yaml` entirely (no Docker Hub equivalent). |
| `.github/workflows/entrypoint-drift.yaml` | added | M2 gate #5: asserts the fork's ENTRYPOINT on `veecode/release-1.10` (minus the appended `--config app-config.veecode.yaml` pair) equals the live `upstream/release-1.10` array. Lives on `veecode/main` (GitHub only registers `schedule`/`workflow_dispatch` workflows from the default branch) **and** on `veecode/release-1.10` (push trigger on Containerfile changes). |
| `veecode/dynamic-plugins.yaml` | added | Baked default `dynamic-plugins.yaml` (`plugins: []`, no `includes:`) COPY'd into the image — M2 D3. Lives on `veecode/release-1.10` only. |
| `veecode/app-config.veecode.yaml` | added | Guest→admin auth mapping (with `dangerouslyAllowOutsideDevelopment: true`, mirroring the 2.x platform default), loaded as the image ENTRYPOINT's fourth `--config` — M2. Lives on `veecode/release-1.10` only. |
| `AGENTS.md` (this file) | added | Drift manifest and fork conventions. |

Upstream files modified: **one** — `build/containerfiles/Containerfile` on `veecode/release-1.10`, strictly **append-only** (M2): four VeeCode blocks appended after the last upstream instruction (baked `dynamic-plugins.yaml`, baked `app-config.veecode.yaml`, `ENV SEGMENT_TEST_MODE=true`, and a new single-line ENTRYPOINT retyping the upstream array plus one extra `--config`). A fifth block (a build-generated documentation-only vitrine at `dynamic-plugins.default.yaml`) shipped in `3.0.0-alpha.2` and was removed on 2026-08-10 (D6 reversed): that filename is a live reserved placeholder in the upstream installer contract (`includes:` entry replaced via `CATALOG_INDEX_IMAGE`), and baking a file there shadows upstream behavior. No upstream line was edited or removed; staleness of the retyped ENTRYPOINT copy is guarded by `entrypoint-drift.yaml`.

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
  pointing back to this manifest. Issues had to be explicitly enabled on
  this repo (`has_issues`, off by default on forks) for this to work.
  Revisit if/when a scoped bot token for cross-repo issue creation is
  provisioned.

- **`veecode/**` ruleset has no `pull_request` rule**: the ruleset API
  rejected the intended bypass actor for the GitHub Actions app
  (`actor_type: Integration, actor_id: 15368`) with:
  `"Actor GitHub Actions integration must be part of the ruleset source or
  owner organization"`. The app ID is globally correct (verified against
  `GET /apps/github-actions`), but it is not usable as a bypass actor for
  this org/repo. Per the fallback instruction, the ruleset
  (`veecode-branch-protection`, id `20555019`) was created with only
  `deletion` and `non_fast_forward`, bypass actor `RepositoryRole` id `5`
  (repo admin) only — no `pull_request` rule.
  **Consequence**: `veecode/main` and `veecode/release-1.10` currently have
  **no require-PR protection**. Anyone with write access can push directly
  to either branch; only deletion and force-push/history-rewrite are
  blocked. This is the concrete exposure created by the fallback, not just
  an absent rule name — flag for a follow-up once org-app bypass is sorted
  out (e.g., an org admin re-checks whether the GitHub Actions app needs to
  be explicitly registered as an org-level ruleset bypass candidate).
  `upstream-sync.yaml`'s own pushes are plain fast-forward merges (never
  force-pushes), so `non_fast_forward` alone does not block the sync bot —
  but this has not been empirically verified yet: upstream hasn't moved
  since fork creation, so the first sync dry-run's merges are no-ops and
  its `git push` never actually updates a ref. Treat the bot's push as
  compatible with the ruleset by reasoning, not as proven.

## Documented deviations from the M1 spec

- **Secret names: `DOCKER_USERNAME`/`DOCKER_PASSWORD`, not
  `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`**. The M1 spec (and its M0
  prerequisite) called for a dedicated, push-only credential pair
  provisioned specifically for this fork. Decision by Gio, 2026-08-07:
  `publish-edge.yaml` uses the existing org-level `DOCKER_USERNAME` /
  `DOCKER_PASSWORD` secrets already visible to this repo (see "Known risk:
  shared Docker Hub org secret" below) instead of provisioning a new pair.
  This is a decision to accept the pre-existing exposure rather than an
  oversight — the dedicated-credential mitigation described in the M0
  prerequisite was not carried out.

- **`publish-edge.yaml` exists on two branches, not one.** The M1 spec says
  to add it on `veecode/release-1.10` only. In practice, GitHub does not
  register a `workflow_dispatch` workflow for dispatch via API/CLI (any
  `--ref`) until the file exists on the repository's **default branch**
  (`veecode/main`); confirmed empirically — `GET
  .../actions/workflows/publish-edge.yaml` 404'd with the file present only
  on `release-1.10`, and started returning the workflow (`state: active`)
  only after the identical file was also committed to `veecode/main`. The
  copy on `veecode/main` cannot run unattended (workflow_dispatch has no
  push/PR trigger); the copy on `release-1.10` is the one that actually
  executes when dispatched with `--ref veecode/release-1.10`.

- **Per-arch tags persist permanently in the shared namespace.** Dropping
  the Quay tag-lifecycle job (per the M1 spec, correctly — there is no
  Docker Hub equivalent) also drops its cleanup step. Upstream deletes its
  per-arch intermediate tags (e.g. `next-amd64`) after building the
  multi-arch manifest list; `publish-edge.yaml`'s per-arch tags (e.g.
  `3.0.0-alpha.1-amd64`) have no such cleanup and will accumulate in
  `docker.io/veecode/devportal` on every publish run. None of them are
  `latest`/`stable`/`2.x`, so this does not violate the hard tag rule, but
  it is a visible, uncleaned artifact in a namespace shared with
  devportal-platform's `publish.yml`. Not remediated here; flag for a
  follow-up if the accumulation becomes a problem.

## Actions hygiene

The M0 spec assumed the fork's inherited workflows would appear via
`GET /repos/.../actions/workflows` in a disabled state, ready to be
disabled/left alone individually. In practice, GitHub does not register an
inherited workflow in that API at all until a matching trigger event
actually fires for it — confirmed by a direct `GET .../actions/workflows/<file>.yaml`
returning 404 for every inherited file, and by polling `total_count` for
~2 minutes with no change. **There is nothing to disable via the API**;
inherited workflows are unaddressable until they first run, and
registration and first execution happen in the same event — there is no
window to disable one reactively before it has already run once.

Reading each inherited workflow's `on:` block instead of relying on the
registry gives the real picture:

- **`pr.yaml`is a no-op on this branch layout.** Its `pull_request` trigger
  filters `branches: ['main', 'release-[0-9]+.[0-9]+']`. Our work happens on
  `veecode/main` / `veecode/release-1.10`, which do not match that filter.
  The M0 spec's "keep `pr.yaml` enabled" therefore does not give us
  upstream's lint/test on our PRs. This needs an explicit decision, not a
  default: either add an additive workflow that mirrors `pr.yaml`'s checks
  scoped to `veecode/**`, or accept there is no automated upstream-style
  check on this line. Not decided here.

- **These *will* run automatically on the first PR opened against
  `veecode/main`**, because their `pull_request` / `pull_request_target`
  triggers have no branch filter (some have path filters, which our first
  PR may or may not match): `pr-build-image.yaml`, `pr-semantic.yaml`,
  `auto-approve-bot-prs.yaml`, `cache-cleanup.yaml`, `codeql.yaml`,
  `toml-checks.yaml`, `e2e-cluster-free.yaml`, `e2e-tests-lint.yaml`,
  `link-checker.yaml`. Of these, **`pr-build-image.yaml`** is the one that
  matters most: it builds (not pushes) an image tagged for
  `quay.io/rhdh-community/rhdh` on every PR, and its companion
  `pr-podman-push.yaml` (triggered via `workflow_run` once the build
  completes) attempts to push that image using `secrets.QUAY_USERNAME` /
  `secrets.QUAY_TOKEN`. Verified: this repo has no such secrets (checked
  `gh api .../actions/secrets` and `.../actions/organization-secrets`), so
  the push step would fail closed rather than actually publish anywhere —
  but the build itself would still run. **Action needed before the first
  real PR is opened against `veecode/main`**: disable these workflows via
  `gh workflow disable` — this only becomes possible once they exist in the
  registry, which won't happen until that first PR event, so whoever opens
  PR #1 needs to expect (and immediately act on) these runs rather than be
  surprised by them.

- **`next-build-image.yaml`**, the file the M0 spec explicitly names as a
  concern, is actually low-risk as configured: its `push` trigger is
  filtered to `main` / `release-[0-9]+.[0-9]+`, and nothing in our
  automation ever advances those branches (only `veecode/main` /
  `veecode/release-1.10` receive commits); its `schedule` trigger is
  unregistered/disabled like all scheduled workflows on a fresh fork; its
  `workflow_dispatch` trigger requires a deliberate manual action. The
  spec's real exposure was `pr-build-image.yaml` (above), which it did not
  name.

- Workflows gated by `schedule`/`workflow_dispatch` only (no push/PR
  trigger), e.g. `stale.yaml`, `sync-owners-aliases.yaml`,
  `update-backstage.yaml`, `update-rpm-lockfile.yaml`,
  `update-versions.yaml`: inert until someone manually dispatches them or
  their schedule is explicitly enabled (schedules start disabled on
  forks). Low risk, no action taken.

## Secret scanning

GitHub secret scanning and push protection are **enabled** on this repo
(verified via `security_and_analysis.secret_scanning.status` and
`.secret_scanning_push_protection.status`, both `"enabled"`).

`secret-scan.yaml` adds gitleaks as a defense-in-depth layer, scoped to the
commits introduced by each push/PR (`--log-opts` with the push's
before/after range, or the PR's base/head range) rather than the repo's
full history. A one-time full-history scan at fork bootstrap
(`fetch-depth: 0`, no range restriction) scanned upstream's ~4,100-commit
history and found **33 pre-existing findings**, all inherited from before
this fork existed (the repo was previously `janus-idp/backstage-showcase`).
These cannot be remediated without rewriting public history, which this
mission's conventions forbid. They are out of scope for M0; track a
follow-up ticket in `devportal-planning` to triage them (redacted findings
only — the workflow run log has the details).

## Known risk: shared Docker Hub org secret already visible to this fork

`GET /repos/veecode-platform/devportal-core/actions/organization-secrets`
returns 8 org-level secrets already accessible to this repo, including
`DOCKER_USERNAME` / `DOCKER_PASSWORD`. No workflow in this fork currently
references either secret, so the exposure is latent, not live. It is
**not confirmed** whether this is the same credential `devportal-platform`'s
`publish.yml` uses — the M0 prerequisite names a differently-named pair
(`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`) as the dedicated, push-only
token to be provisioned *for this fork specifically*, precisely to avoid
reusing whatever `devportal-platform` uses. If `DOCKER_USERNAME` /
`DOCKER_PASSWORD` turns out to be that same production credential, its
current org-wide visibility already extends it to this public fork ahead
of M1, which is the exact blast-radius scenario the M0 prerequisite was
written to prevent. Needs verification by someone with `devportal-platform`
access and org-secret visibility settings (this session's token lacks
`admin:org`).
