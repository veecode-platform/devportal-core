# AGENTS.md — drift manifest for devportal-core

This repository is a fork of [redhat-developer/rhdh](https://github.com/redhat-developer/rhdh),
maintained as the product base for **VeeCode DevPortal**. Planning, tickets, and
mission conventions live in [veecode-platform/devportal-planning](https://github.com/veecode-platform/devportal-planning)
(private) — read that repo's `AGENTS.md` for the full mission context before
making structural changes here.

## Branch layout

- `main` — upstream mirror. Never receives our commits directly; only the
  weekly sync workflow writes to it (fast-forward from `upstream/main`).
- `veecode/main` — **default branch, and the product/image-building branch as
  of M3.5** (re-anchor, [ADR-002](https://github.com/veecode-platform/devportal-planning/blob/main/docs/adr/002-reanchor-to-main.md)).
  Our drift over upstream `main` lives here — including the six append-only
  Containerfile blocks and the `veecode/` files (see below). All feature
  work, PRs, and the `3.0.0-alpha.5`+/`:edge` image line build from this
  branch.
- `veecode/release-1.10` — stable production line, tracks upstream
  `release-1.10`. **Frozen at `3.0.0-alpha.4`** per ADR-002; no further drift
  lands here going forward (the product line moved to `veecode/main`).

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
| `.github/workflows/publish-edge.yaml` | added | `workflow_dispatch`-only build/publish channel for `docker.io/veecode/devportal` (M1). Since the M3.5 re-anchor it runs from `veecode/main` (the product branch — first main-built publish: `3.0.0-alpha.5`, run 31439078480); the `veecode/release-1.10` copy remains but that line is frozen at `3.0.0-alpha.4` (see "Documented deviations from the M1 spec" below for the two-branch registration history). Reuses `./.github/actions/get-sha` and `./.github/actions/docker-build` unmodified; drops the Quay tag-lifecycle logic from `next-build-image.yaml` entirely (no Docker Hub equivalent). Since OD1 phase C, the `merge` job also checks out the repo, logs in to `quay.io` (reusing the `QUAY_USERNAME`/`QUAY_TOKEN` secret names `next-build-image.yaml` already uses there against `quay.io/rhdh-community/rhdh` — write access to the `veecode` org via those same secrets is unverified from this repo), and anchors every `oci://<image>@sha256:<digest>` ref in `veecode/dynamic-plugins.veecode.yaml` as a stable `<image>:face-<version>` tag after `skopeo inspect`-verifying it resolves — failing the publish loudly on a dead face pin instead of letting it surface as a pod boot crash-loop (see the `veecode/dynamic-plugins.veecode.yaml` row). |
| `.github/workflows/entrypoint-drift.yaml` | added | M2 gate #5, **inverted at M4.6 (`3.0.0-beta.1`)**: now asserts the fork's effective ENTRYPOINT on `veecode/main` is **byte-identical** to the live `upstream/main` array — i.e. that this fork adds no ENTRYPOINT override at all. Until M4.6 it asserted "upstream array + the appended `--config app-config.veecode.yaml` pair"; that pair, and the retyped ENTRYPOINT that carried it, were removed when the auth fragment moved to the config layer. The inverted check still catches both directions: upstream changing its own array, and an override being re-introduced here without a recorded decision. Retargeted from `release-1.10` to `main` at M3.5 (the re-anchor) since `veecode/main` is now the product/image-building branch. Runs entirely on `veecode/main`: `schedule`/`workflow_dispatch` (GitHub only registers those from the default branch) and the Containerfile-changes `push` trigger now share the same branch, so no cross-branch checkout is needed. `veecode/release-1.10`'s copy is untouched (frozen at `3.0.0-alpha.4`) and still asserts against upstream `release-1.10`. |
| `veecode/dynamic-plugins.yaml` | added | Baked default `dynamic-plugins.yaml` COPY'd into the image — M2 D3. Since OD1 phase A it also carries `includes: [dynamic-plugins.veecode.yaml]`, so a plain `docker run` (no Helm chart) still boots with the VeeCode product face instead of faceless; under Helm the chart's rendered ConfigMap replaces this file entirely, so there is no duplicate-face risk. Ported to `veecode/main` at M3.5 (the product branch going forward); the `veecode/release-1.10` copy remains, frozen at `3.0.0-alpha.4`. |
| `veecode/dynamic-plugins.veecode.yaml` | added (OD1 phase A) | Baked VeeCode product face (Home, header, TechDocs, Notifications, Tech Radar, Marketplace, theme — 20 entries), the canonical version source for those plugins (digest-pinned OCI/npm refs; `./dynamic-plugins/dist/...` local refs carry as-is). Wired into the chart's `global.dynamic.includes` at level 0, ahead of the marketplace write-through file. **Main-only deviation from `veecode/release-1.10`, mitigated at build time**: on `release-1.10` a missing/unlisted face file fails the *boot* closed, enforced inside the vendorized `install-dynamic-plugins.py` (see that branch's own manifest). On `veecode/main` that script does not exist — the installer is consumed from npm (`@red-hat-developer-hub/cli-module-install-dynamic-plugins@0.4.0`, see the M3.5 re-anchor note below), which has no equivalent boot-time fail-closed/backstop guard, and there is no patch point to add one (no `.yarn/patches` entry for that package). Instead, the Containerfile appends a `RUN` right after this file's `COPY` that fails the **image build** if it is missing, empty, does not contain exactly 20 `- package:` entries, or references a `./dynamic-plugins/dist/...` local path that does not resolve to a real directory in the image (the npm installer WARN+SKIPs missing local packages with exit 0 — the per-path check exists because `3.0.0-beta.3` shipped a silently partial face: 5 backend refs lacked the `-dynamic` suffix the exported dist dirs carry) — the image cannot be produced with a broken face, even though nothing re-checks it at container boot. The Helm path has its own independent gate (chart's values-schema validation, chart 0.1.10+). Net: the boot-time **wired-backstop** (file present on disk but dropped from `includes:`) specifically does **not** exist on `veecode/main` — the build-time count assertion only catches a broken/short file, not a correct file that got silently unlisted from `includes:` by a downstream edit. `veecode/regenerate-extensions-install.js` still dedups the marketplace regen against this file so a face package is never re-declared at the same includes level. Ported to `veecode/main` at OD1 (image-side); the `veecode/release-1.10` copy is the original. |
| `veecode/app-config.veecode.yaml` | added M2, **REMOVED at M4.6** | Guest→admin auth mapping (with `dangerouslyAllowOutsideDevelopment: true`, mirroring the 2.x platform default), loaded as the image ENTRYPOINT's fourth `--config` — M2; ported to `veecode/main` at M3.5. **Deleted in `3.0.0-beta.1`**: a fixed ENTRYPOINT array admits no conditional argument without a shell wrapper (the 2.x smart-entrypoint pattern this fork reverses), so welded here the guest provider had no off switch — chart-side `extraAppConfig` only appends and cannot remove a key the image already set. The fragment now ships in the VeeCode default config (chart values / local runner), where delivering it or not is the lever. Rationale: devportal-planning `docs/adr/003` amendment point 9 + `docs/milestones/M4.6.md`. The `veecode/release-1.10` copy remains, frozen at `3.0.0-alpha.4`. |
| `veecode/regenerate-extensions-install.js` | added | Stateless Postgres→YAML pre-step ported from devportal-platform's ADR-014 (`docker/regenerate-extensions-install.js`) — M3 front 3, decision Q7. Staged in the image (COPY only) but never executed by any code path here — no ENTRYPOINT/CMD reference to it; orchestration outside this repo chains it ahead of the installer at the install-step (`node regenerate-extensions-install.js --config <...> && sh install-dynamic-plugins.sh <root>`). Trimmed vs. the 2.x original: CWD-relative paths instead of `/app`, and the `EXTENSIONS_PRESTEP_FAIL_CLOSED`/exit-78 escape hatch dropped entirely (D2: this pre-step script itself never fails closed on boot — a DB or write error always degrades to "leave the existing YAML in place"). Since OD1 phase A this script also dedups its output against the baked face file (`normalizePluginKey`/`loadFacePackageKeys`, best-effort) — see the `veecode/dynamic-plugins.veecode.yaml` row above for the main-only caveat on the installer-side half of that guard. Ported to `veecode/main` at M3.5 (the product branch going forward); the `veecode/release-1.10` copy remains, frozen at `3.0.0-alpha.4`. |
| `veecode/merge-dynamic-plugins.js` | added (OD1 phase B) | Level-1 config merge, staged (COPY only) the same way as `regenerate-extensions-install.js` — never invoked by any ENTRYPOINT/CMD in this repo; orchestration outside this repo chains it between that regen and the installer (`node regenerate-extensions-install.js --config <...> && node merge-dynamic-plugins.js && sh install-dynamic-plugins.sh <root>`). Reads the operator's `dynamic-plugins.yaml` from `DEVPORTAL_OPERATOR_CONFIG` (fatal, exit 1, if missing/unreadable/invalid — this is the deploy's source of truth) and the marketplace write-through from `${DEVPORTAL_DB_PATH}/extensions-install.yaml` (soft-degrades to operator-only if missing/empty), then writes `/opt/app-root/src/dynamic-plugins.yaml` (the installer's hardcoded CWD-relative read path) with `plugins: operator.plugins ++ extensions.plugins`, dropping any extensions entry whose normalized key (reuses `regenerate-extensions-install.js`'s `normalizePluginKey`) collides with an operator entry. Exists because the marketplace write-through previously entered as a level-0 `includes:` entry, colliding fatally with the catalog-index DPDY (also level 0) on any overlapping plugin key regardless of `disabled` state; landing it at level 1 instead makes a marketplace install a sanctioned cross-level override of a DPDY entry. |
| `AGENTS.md` (this file) | added | Drift manifest and fork conventions. |

Upstream files modified: **one** — `build/containerfiles/Containerfile`, strictly **append-only**. M2 appended four blocks after the last upstream instruction (baked `dynamic-plugins.yaml`, baked `app-config.veecode.yaml`, `ENV SEGMENT_TEST_MODE=true`, and a new single-line ENTRYPOINT retyping the upstream array plus one extra `--config`). **At M4.6 (`3.0.0-beta.1`) two of those four were removed** — the baked `app-config.veecode.yaml` COPY and the retyped ENTRYPOINT, which existed only to carry it (see the `veecode/app-config.veecode.yaml` row above). Both are replaced by explanatory comment blocks, so the append-only discipline holds and the removal is legible in place. **The fork no longer overrides upstream's ENTRYPOINT at all**, which is what `entrypoint-drift.yaml` now asserts. Live drift in this file is therefore: the baked `dynamic-plugins.yaml`, `ENV SEGMENT_TEST_MODE=true`, the M3 pre-step COPY, and — since OD1 phase A — the baked `dynamic-plugins.veecode.yaml` COPY. A fifth block (a build-generated documentation-only vitrine at `dynamic-plugins.default.yaml`) shipped in `3.0.0-alpha.2` and was removed on 2026-08-10 (D6 reversed): that filename is a live reserved placeholder in the upstream installer contract (`includes:` entry replaced via `CATALOG_INDEX_IMAGE`), and baking a file there shadows upstream behavior. M3 front 3 (Q7) appended a sixth block: `COPY veecode/regenerate-extensions-install.js` at the WORKDIR root plus a `chmod a=r`, staged after the ENTRYPOINT with no ENTRYPOINT/CMD change of its own. OD1 phase A appended a seventh block: `COPY veecode/dynamic-plugins.veecode.yaml`, alongside the existing baked `dynamic-plugins.yaml` COPY. OD1 phase B appended an eighth block, immediately after the sixth: `COPY veecode/merge-dynamic-plugins.js` plus a `chmod a=r`, same staged-but-never-invoked shape as the regen script it sits next to. No upstream line was edited or removed; staleness of the retyped ENTRYPOINT copy is guarded by `entrypoint-drift.yaml`, which reads only the last `^ENTRYPOINT` line and is unaffected by blocks appended after it.

**On the installer-side half of OD1's fail-closed guard**: `veecode/release-1.10`'s OD1 work also patched `scripts/install-dynamic-plugins/install-dynamic-plugins.py` (a small localized diff in the `includes` resolution loop: a fatal `InstallException` when the missing include is the product-face file, plus a backstop when that file exists on disk but isn't wired into `includes` at all). That file does not exist on `veecode/main` — upstream ported the installer from Python to TypeScript (`105732db`) and then moved its consumption to an npm package (`@red-hat-developer-hub/cli-module-install-dynamic-plugins`, `1059aaaa`; see the M3.5 re-anchor note below). No equivalent patch point exists in this repo for `veecode/main` today (no `.yarn/patches` entry for that package). **Decided replacement (OD1 port, main-only)**: rather than standing up npm-patch infrastructure to recreate the Python guard, the Containerfile asserts the face file's shape at build time instead of at boot (see the `RUN` right after the `COPY veecode/dynamic-plugins.veecode.yaml` line) — a plain `grep -c '^- package:'` count plus a per-entry existence check for every `./dynamic-plugins/dist/...` local ref, failing the image build if the file is missing, empty, not exactly 20 entries, or naming a dist directory the image does not contain. This closes the "broken/short file" and "wrong local path, silently partial face" failure modes (the latter shipped in `3.0.0-beta.3`) but not the "correct file, silently dropped from `includes:`" failure mode (the boot-time wired-backstop) — that half of OD1's guard genuinely has no equivalent on `veecode/main` today. The Helm path is separately guarded by the chart's own values-schema gate (chart 0.1.10+).

**M3.5 re-anchor** (historical; two of these blocks were later removed at M4.6,
see above): these same six blocks were ported, unchanged, onto
`veecode/main`'s Containerfile — upstream's ENTRYPOINT array and WORKDIR
(`/opt/app-root/src`) are byte-identical between `release-1.10` and `main`,
so the port was a straight copy. `veecode/main` is now the
product/image-building branch (`3.0.0-alpha.5`+ ≡ `:edge`); the
`veecode/release-1.10` Containerfile is untouched and frozen at
`3.0.0-alpha.4`. One thing changed underneath the port: on `veecode/main`,
`install-dynamic-plugins.sh` is generated by the npm package
`@red-hat-developer-hub/cli-module-install-dynamic-plugins@0.4.0`, not the
vendorized Python installer (`install-dynamic-plugins.py`) that
`release-1.10`'s Backstage line ships — the npm installer reads the same
fixed `dynamic-plugins.yaml` at CWD, so the M2 D3 baked-file contract holds
unchanged.

**Value delta introduced by the port**: `veecode/main` carries upstream's
own *development* `SEGMENT_WRITE_KEY` baked into its Containerfile;
`veecode/release-1.10` carries upstream's *production* key for its older
Backstage line. Both are inert here regardless: our `ENV
SEGMENT_TEST_MODE=true` (M2 block 3, appended after upstream's own
`SEGMENT_TEST_MODE=false`) disables Segment telemetry outright, independent
of which key ships underneath it.

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
  only after the identical file was also committed to `veecode/main`.
  Through M3 the copy on `release-1.10` was the one that actually executed
  (dispatched with `--ref veecode/release-1.10`, alphas 1-4). Since the
  M3.5 re-anchor (ADR-002) the roles flipped: `veecode/main` is the product
  branch and dispatches run with `--ref veecode/main` (first: `3.0.0-alpha.5`);
  the `release-1.10` copy remains but its line is frozen at `3.0.0-alpha.4`.

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
