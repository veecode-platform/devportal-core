# Upstream drift manifest for devportal-core

> **Branch rename (2026-08-26, ADR-009 in devportal-planning):** the product
> branch `veecode/main` is now **`main`**; the untouched upstream mirror that
> used to be `main` is now **`upstream/main`**. Reason: Backstage's GitHub URL
> reader cannot resolve `blob/<branch-with-slash>/<path>` through the API.
> Everything below that says `veecode/main` refers to today's `main`; the
> inherited RHDH workflows filtered on `main` are no longer inert — the
> image-building/PR-opening ones were disabled with `gh workflow disable`.


This repository is a fork of [redhat-developer/rhdh](https://github.com/redhat-developer/rhdh),
maintained as the product base for **VeeCode DevPortal**. Planning, tickets, and
mission conventions live in [veecode-platform/devportal-planning](https://github.com/veecode-platform/devportal-planning)
(private) — read that repo's `AGENTS.md` for the full mission context before
making structural changes here.

## Branch layout

- `main` is the default branch and the product line: every image from
  `3.0.0-alpha.5` on, including `:edge`, builds from it. Our drift over
  upstream lives here, including the append-only Containerfile blocks and the
  `veecode/` files listed below.
- `upstream/main` is the untouched mirror of `redhat-developer/rhdh` `main`
  that used to be called `main`.
- `veecode/release-1.10` tracks upstream `release-1.10` and is frozen at
  `3.0.0-alpha.4` per ADR-002. No sync or drift lands there.

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
| `.github/workflows/upstream-sync.yaml` | added | Weekly automated merge from `upstream/main` → `main`; opens an issue on conflict. The `veecode/release-1.10` job was removed on 2026-09-25: that line is frozen at `3.0.0-alpha.4` and the job failed every week. |
| `.github/workflows/secret-scan.yaml` | added | Runs gitleaks on push and pull_request against `veecode/**` branches. |
| `.github/workflows/publish-edge.yaml` | added | `workflow_dispatch`-only build/publish channel for `docker.io/veecode/devportal` (M1). Since the M3.5 re-anchor it runs from `veecode/main` (the product branch — first main-built publish: `3.0.0-alpha.5`, run 31439078480); the `veecode/release-1.10` copy remains but that line is frozen at `3.0.0-alpha.4` (see "Documented deviations from the M1 spec" below for the two-branch registration history). Reuses `./.github/actions/get-sha` and `./.github/actions/docker-build` unmodified; drops the Quay tag-lifecycle logic from `next-build-image.yaml` entirely (no Docker Hub equivalent). Since OD1 phase C, the `merge` job also checks out the repo, logs in to `quay.io` (reusing the `QUAY_USERNAME`/`QUAY_TOKEN` secret names `next-build-image.yaml` already uses there against `quay.io/rhdh-community/rhdh` — write access to the `veecode` org via those same secrets is unverified from this repo). The step that anchored the product face's digests was removed with the face.  The upstream image workflow assembles multi-arch manifests from per-architecture digests with Docker Buildx rather than copying a manifest list with Skopeo ([source](https://github.com/redhat-developer/rhdh/blob/049671d612b598e61845b9ac500e313411c91b61/.github/workflows/next-build-image.yaml#L279-L298)); the fork-specific anchor copies in this workflow and `.github/workflows/anchor-digest.yaml` now use `--preserve-digests` to reject list rewrites. |
| `.github/actions/docker-build/action.yaml` | modified | Caches the hermeto prefetch (`actions/cache` restore/save) keyed by runner architecture, the hermeto image digest and the hashes of `yarn.lock`, `dynamic-plugins/yarn.lock`, `rpms.in.yaml`, `rpms.lock.yaml` and the `python/` requirements and hermeto inputs; a hit skips `fetch-deps` (about 6 min per architecture), a miss fetches as upstream does and saves only a successful fetch. The fetch, save and env/inject phases are separate steps. On the 1.54 line `dynamic-plugins/yarn.lock` no longer exists, so that pattern matches no file and adds nothing to the key. `HERMETO_IMAGE` is pinned to hermeto 0.62.0 by digest (`sha256:79e498bf...`), where RHDH uses `:latest`: 0.63.0, published 2026-10-13, ships no arm64 image, so the arm64 build fails pulling it. Drop the pin when a hermeto release ships arm64 again. |
| `README.md` | modified | Adds the VeeCode DevPortal image, Helm chart, 3.x preview guide, and contributor pointer above the upstream README. |
| `.github/workflows/anchor-digest.yaml` | added | `workflow_dispatch`-only utility: anchors an arbitrary `quay.io/veecode/<image>@<digest>` under an operator-chosen immutable tag via `skopeo copy --all`, then verifies the tag resolves back to the same digest. Same `QUAY_USERNAME`/`QUAY_TOKEN` secrets as publish-edge's face anchor. Exists because quay GCs untagged manifests once a moving tag (e.g. `bs_1.52.0`) is republished over them — first used to preserve the M5-verified `vertigo-theme` build (`f46405d8…`) during the 2026-08-20 curation-regression investigation. |
| `.github/workflows/promote-image.yaml` | added | `workflow_dispatch`-only release step: promotes an approved candidate tag of `docker.io/veecode/devportal` to its final tag without rebuilding, by running the release skill's `promote-image.sh` (`skopeo copy --all --preserve-digests`, fails unless the final digest equals the candidate digest). Uses the same `DOCKER_USERNAME` / `DOCKER_PASSWORD` secrets as `publish-edge.yaml` and refuses the forbidden tags (`latest`, `stable`, `2.x`) like it. |
| `.github/workflows/entrypoint-drift.yaml` | added | M2 gate #5, **inverted at M4.6 (`3.0.0-beta.1`)**: now asserts the fork's effective ENTRYPOINT on `veecode/main` is **byte-identical** to the live `upstream/main` array — i.e. that this fork adds no ENTRYPOINT override at all. Until M4.6 it asserted "upstream array + the appended `--config app-config.veecode.yaml` pair"; that pair, and the retyped ENTRYPOINT that carried it, were removed when the auth fragment moved to the config layer. The inverted check still catches both directions: upstream changing its own array, and an override being re-introduced here without a recorded decision. Retargeted from `release-1.10` to `main` at M3.5 (the re-anchor) since `veecode/main` is now the product/image-building branch. Runs entirely on `veecode/main`: `schedule` (GitHub registers schedules only from the default branch) and the Containerfile-changes `push` trigger now share the same branch; `workflow_dispatch` also runs from a branch that carries the file (run 38454876059), so no cross-branch checkout is needed. `veecode/release-1.10`'s copy is untouched (frozen at `3.0.0-alpha.4`) and still asserts against upstream `release-1.10`. |
| `.github/workflows/veecode-rpm-lockfile.yaml` | added | VeeCode-only replacement for the disabled `update-rpm-lockfile.yaml`, which needs `RHDH_BOT_TOKEN` and opens PRs with `/lgtm`. Regenerates `rpms.lock.yaml` on `ubuntu-24.04` (pinned because `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19) with `rpm-lockfile-prototype` pinned to commit `bd52a866369b2c6cc701e8d43ca8665fed51e0c7` (tag `v0.30.1`; the fetch uses the commit because a tag can move) (apt: podman, skopeo, rpm, dnf, python3-dnf; venv with system site packages), checks that every arch in `rpms.in.yaml` has packages, uploads the lock as the `rpms.lock.yaml` artifact and writes a step summary with package counts per arch and names added, removed and changed against the committed lock. `permissions: contents: read`; no token, no commit, no PR: a person downloads the artifact and commits it. Triggers: `workflow_dispatch`, and pushes to branches other than `main` that change `rpms.in.yaml`, `rpms.lock.yaml`, the Containerfile or the workflow itself, so it runs from a branch before reaching `main`. The upstream workflow stays disabled and untouched. |
| `veecode/dynamic-plugins.yaml` | added | Baked default, COPY'd since beta.6 to `dynamic-plugins.yaml.baked` while the live path `/opt/app-root/src/dynamic-plugins.yaml` became a symlink into the data volume (`/devportal-data/dynamic-plugins.yaml`, written by `merge-dynamic-plugins.js` at pre-install; with no volume/merge the link dangles and the installer warn-skips — same net zero-plugin behavior as the old baked default) — M2 D3, reworked OD1 phase B. It carries `includes: [dynamic-plugins.default.yaml]` only, so a plain `docker run` (no Helm chart) boots with no factory plugins until a catalog index is set; under Helm the chart's rendered ConfigMap replaces this file entirely, so there is no duplicate-face risk. Ported to `veecode/main` at M3.5 (the product branch going forward); the `veecode/release-1.10` copy remains, frozen at `3.0.0-alpha.4`. |
| `veecode/dynamic-plugins.veecode.yaml` | added (OD1 phase A), **REMOVED** | Retired product face (20 entries). Its enabled entries are factory plugins that the catalog index now enables; the image keeps only their names, in `veecode/factory-plugins.yaml`. No RHDH equivalent. |
| `veecode/factory-plugins.yaml` | added | Names-only list of the factory plugins that the catalog index enables: each entry has the repository, the loaded-plugin path and, for four entries, `protected: true`. The Marketplace pre-step and the image build check read it. No RHDH equivalent: RHDH's index enables its default plugins without a names-only list in the image. |
| `docs/release-notes/3.0.0.md` | added | States that 18 face entries are enabled by default, an enabled former Tech Radar local-path override loaded alongside the OCI face entry in a beta.10 runtime check, and tag or digest overrides pin an artifact version. |
| `docs/release-notes/3.1.0.md` | added | States that the 3.1.0 image has no `dynamic-plugins/` directory and its installer skips former `./dynamic-plugins/dist/...` entries with exit 0, lists the Scaffolder, multer and proxy-addr fixes, the RBAC backend 8.1.4 and frontend 2.3.1 pair, the versions kept at their 3.0.x levels, the factory plugin list that replaces the baked plugin file, the chart 1.1.0 upgrade checks for an old include, a digest override and `--reuse-values`, the table that holds Marketplace selections, the qualification run, and the 1.54.9 catalog index that the overlays change merged. |
| `veecode/app-config.veecode.yaml` | added M2, **REMOVED at M4.6** | Guest→admin auth mapping (with `dangerouslyAllowOutsideDevelopment: true`, mirroring the 2.x platform default), loaded as the image ENTRYPOINT's fourth `--config` — M2; ported to `veecode/main` at M3.5. **Deleted in `3.0.0-beta.1`**: a fixed ENTRYPOINT array admits no conditional argument without a shell wrapper (the 2.x smart-entrypoint pattern this fork reverses), so welded here the guest provider had no off switch — chart-side `extraAppConfig` only appends and cannot remove a key the image already set. The fragment now ships in the VeeCode default config (chart values / local runner), where delivering it or not is the lever. Rationale: devportal-planning `docs/adr/003` amendment point 9 + `docs/milestones/M4.6.md`. The `veecode/release-1.10` copy remains, frozen at `3.0.0-alpha.4`. |
| `veecode/regenerate-extensions-install.js` | added | Stateless Postgres→YAML pre-step ported from devportal-platform's ADR-014 (`docker/regenerate-extensions-install.js`) — M3 front 3, decision Q7. Staged in the image (COPY only) but never executed by any code path here — no ENTRYPOINT/CMD reference to it; orchestration outside this repo chains it ahead of the installer at the install-step (`node regenerate-extensions-install.js --config <...> && sh install-dynamic-plugins.sh <root>`). Trimmed vs. the 2.x original: CWD-relative paths instead of `/app`, and the `EXTENSIONS_PRESTEP_FAIL_CLOSED`/exit-78 escape hatch dropped entirely (D2: this pre-step script itself never fails closed on boot — a DB or write error always degrades to "leave the existing YAML in place"). Since round 1, a marketplace row for a face plugin maps to the face entry with `samePlugin`; the generated entry uses that face package and a boolean `disabled`, skips digest resolution and persistence, and warns when it ignores `pluginConfig`. Disabled rows for the four protected Marketplace face plugins are ignored with a warning. A selector-less row matching face entries with distinct selectors is warned and handled as a non-face row. It pins every enabled OCI selection to a digest, with or without a `!` selector, whether the ref names a tag or a digest: a stored `resolved_digest` is reused with no registry call, and otherwise the ref is resolved once with `skopeo inspect`, which is also the check that the image exists (the installer fails the whole install on one missing image); the digest is stored when that column exists. An enabled row whose digest cannot be resolved is skipped with a warning instead of abandoning the whole regeneration, and disabled rows are never resolved. OCI rows are reduced before resolution because installer 0.4.1 (the version on `main` when this was observed) fails the whole install when two enabled entries use one plugin key. Selector-bearing rows are grouped by exact repository and selector. Selector-less rows join the group only when the repository has one distinct selector; with multiple selectors, they are omitted with a warning naming the selector-less and matched selector-bearing rows because the installer rejects a path-less reference to a multi-plugin image. Selector-less-only rows form one group. Within a group, `preferredRow` keeps an enabled row over a disabled row, then the latest `updated_at`, and warns for discarded rows. This grouping adds no table write. Rows that are not OCI refs are not grouped. `veecode/test/regenerate-extensions-install.test.js` covers these rules, the four ambiguous selector omission cases (both repository orderings with the selector-less row newest and oldest), the two-row preference, ambiguous face matches, and the real product face. Ported to `veecode/main` at M3.5 (the product branch going forward); the `veecode/release-1.10` copy remains, frozen at `3.0.0-alpha.4`. |
| `veecode/test/regenerate-extensions-install.test.js` | added | `node:test` suite for `regenerate-extensions-install.js`. Database-backed cases seed `marketplace_installations` in Postgres, put a fake `skopeo` first on `PATH`, run the script, and assert the generated YAML, stored digests and logs. It covers the 11 shared `samePlugin` vectors, face mapping and protection, the real face file, selector differences, the four ambiguous selector-less omission cases (both repository orderings with the row newest and oldest), the single-selector preferred row, and ambiguous face matching with non-face omission. Run by `veecode-prestep-test.yaml`. |
| `.github/workflows/veecode-prestep-test.yaml` | added | Runs `node --test "veecode/test/*.test.js"` on pull requests that touch `veecode/**`, `yarn.lock` or `.nvmrc`, with a Postgres service container and Node from `.nvmrc`. It installs only `pg`, `yaml` and `@backstage/config-loader`, pinned to the versions `yarn.lock` resolves (they are transitive dependencies of `packages/backend`), and fails when `yarn.lock` stops resolving those versions. No other workflow runs a test for `veecode/`. |
| `veecode/merge-dynamic-plugins.js` | added (OD1 phase B) | Level-1 config merge, staged (COPY only) the same way as `regenerate-extensions-install.js` — never invoked by any ENTRYPOINT/CMD in this repo; orchestration outside this repo chains it between that regen and the installer (`node regenerate-extensions-install.js --config <...> && node merge-dynamic-plugins.js && sh install-dynamic-plugins.sh <root>`). Reads the operator's `dynamic-plugins.yaml` from `DEVPORTAL_OPERATOR_CONFIG` (fatal, exit 1, if missing/unreadable/invalid — this is the deploy's source of truth) and the marketplace write-through from `${DEVPORTAL_DB_PATH}/extensions-install.yaml` (soft-degrades to operator-only if missing/empty), then writes `${DEVPORTAL_DB_PATH}/dynamic-plugins.yaml` (fatal without DEVPORTAL_DB_PATH; the installer's hardcoded CWD read path `/opt/app-root/src/dynamic-plugins.yaml` is a baked SYMLINK to that volume location since beta.6 — the init container runs readOnlyRootFilesystem, and the beta.5 first boot died EROFS writing to the image fs; after writing, the script realpath-asserts the symlink resolves to its output and is fatal on divergence) with `plugins: operator.plugins ++ extensions.plugins`, dropping any extensions entry that `samePlugin` matches to an operator entry. Each marketplace row is compared directly with deploy entries, so a selector-less operator entry intentionally suppresses rows for every selector in that repository; deploy configuration wins. Exists because the marketplace write-through previously entered as a level-0 `includes:` entry, colliding fatally with the catalog-index DPDY (also level 0) on any overlapping plugin key regardless of `disabled` state; landing it at level 1 instead makes a marketplace install a sanctioned cross-level override of a DPDY entry. |
| `veecode/test/merge-dynamic-plugins.test.js` | added | `node:test` suite that runs the merge script against temporary operator and marketplace YAML files without a database. It covers selector-less rows overridden by the deploy, different selectors on one repository, and face-plugin rows that pass through. |
| `AGENTS.md`, `CLAUDE.md` | added | Agent router; `CLAUDE.md` delegates to it. |
| `docs/upstream-drift.md` (this file) | added | Drift manifest and fork conventions. |
| `build/containerfiles/Containerfile` (the two `FROM` lines), `.nvmrc`, `.nvm/releases/node-v24.21.0-headers.tar.gz`, `.nvm/releases/README.adoc`, `rpms.lock.yaml` | modified (Backstage 1.54 base refresh) | Base images refreshed to the current 10.2 builds: `ubi10/nodejs-24:10.2-1791850775` (skeleton) and `ubi10/nodejs-24-minimal:10.2-1791916595` (runner), both built 2026-10-13 and pinned by manifest-list digest as before. The skeleton ships Node.js 24.21.0, so `.nvmrc` is 24.21.0 and `.nvm/releases/` holds the matching headers tarball (sha256 `57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2`, equal to its line in nodejs.org's `SHASUMS256.txt`) and no 24.19.0 tarball; the README is RHDH's text for 24.21.0. `rpms.lock.yaml` is regenerated by the `VeeCode RPM Lockfile` workflow (run 38455232158, `rpm-lockfile-prototype` v0.30.1), with `rpms.in.yaml` unchanged from RHDH `3ac14d77`: 495 aarch64 and 492 x86_64 packages, none added or removed, 23 versions change per arch. In a sync, keep whichever digests are newer and regenerate the lock with the workflow. |
| `build/containerfiles/Containerfile` (the two `FROM` lines), `.nvmrc`, `.nvm/releases/node-v24.19.0-headers.tar.gz`, `.nvm/releases/README.adoc`, `rpms.lock.yaml` | modified (M22 V1; history, superseded on the 1.54 line by the UBI10 row above) | Base images refreshed to the newest digests of the 9.8 line: `ubi9/nodejs-24:9.8-1790751326` (skeleton) and `ubi9/nodejs-24-minimal:9.8-1790647840` (runner), each pinned by manifest-list digest as before, to pick up the OS package fixes Red Hat shipped since `3.0.0-beta.10`. Both now ship Node.js v24.19.0 (the beta.10 bases shipped v24.18.0) and the skeleton stage refuses to build unless a vendored headers tarball matches `node --version`, so the v24.18.0 tarball is replaced by v24.19.0 (sha256 `54f14a29…3e4c`, equal to the `SHASUMS256.txt` nodejs.org publishes for that release), `.nvmrc` follows and the README's example output and date are updated, as `.nvm/releases/README.adoc` prescribes. `rpms.lock.yaml` is regenerated with `rpm-lockfile-prototype -f build/containerfiles/Containerfile rpms.in.yaml` (tool commit `b5940ed5`), because the old lock pinned `openssl-devel` 3.5.5 to an `openssl-libs` 3.5.5 that the new skeleton no longer has, so the hermetic `dnf install` could not be satisfied; 124 package versions change per architecture and no package is added or removed. The `Update RPM Lockfile` workflow is disabled in this fork, so the lock is refreshed by hand with each base bump. Upstream's bot makes the same file changes on its own bumps: in a sync, keep whichever pair of digests is newer and regenerate the lock. |
| `package.json` (`resolutions`), `yarn.lock`, `dynamic-plugins/yarn.lock` | modified (M22 V1) | Lifts vulnerable transitive dependencies to releases that fix them, inside the same major version. Both critical findings of the `3.0.0-beta.10` image scan are fixed: `tar` 7.5.16 to 7.5.22 (CVE-2026-59873, plus two highs) and `vm2` 3.11.5 to 3.11.7 (CVE-2026-47686, CVE-2026-47698, GHSA-m5w8-4gq2-6f8x, plus two highs). 3.11.7 also fixes the ten critical vm2 advisories published on 2026-10-01 that the `3.0.0-rc.1` image scan reports (CVE-2026-92935, CVE-2026-92937, CVE-2026-92938, CVE-2026-92939, CVE-2026-92940, CVE-2026-92941, CVE-2026-92944, CVE-2026-92948, CVE-2026-92951 and CVE-2026-92957). The high findings with a fix inside the same major are fixed too: `@grpc/grpc-js`, `axios`, `brace-expansion` (1.x, 2.x and 5.x), `fast-uri`, `http-proxy-middleware` (3.x), `js-yaml` (3.x and 4.x), `multer`, `picomatch`, `undici` (6.x and 7.x) and `ws`. **Root workspace**: the pins are `resolutions` in the same form as the existing ones, exact versions that are the first release fixing every advisory of that major (`tar` reuses 7.5.22, already locked for another range). A package with several majors in the lockfile is pinned per dependency range (`name@npm:^2.0.1`), so no other major moves; a package with one major is pinned by name. **`dynamic-plugins`**: no `resolutions`. `janus-cli package export-dynamic-plugin` installs each plugin tree under `dynamic-plugins/dist` from a copy of `dynamic-plugins/yarn.lock` and does not carry the workspace's `resolutions`, so a resolution rewrites the lock's descriptors and the export then resolves them again, unlocked (seen on an online export: `http-proxy-middleware` 4.2.0, a major bump). The lock is instead updated with `yarn up -R` (every range kept, resolved versions moved to the newest release inside it), plus two hand edits: `http-proxy-middleware@npm:*` is set to 3.0.7, because the range `*` would otherwise resolve to 4.x, and `vm2@npm:^3.10.0` is set to 3.11.7, the same release as the root pin, although `yarn up -R` would move it to the newest 3.x release. Not fixed here because the fix is in another major: `nodemailer` 8 (fixed in 9), `undici` 5 (fixed in 6), `urllib` 3 (fixed in 2 and 4). Each root pin is a floor, not a preference: remove it once the lockfile resolves a newer version without it. After an upstream sync, resolve a `yarn.lock` conflict by regenerating the file; the pins in `package.json` apply again, and `dynamic-plugins/yarn.lock` needs the `yarn up -R`, the `http-proxy-middleware` edit and the `vm2` edit again. On the 1.54 line the `dynamic-plugins/` wrapper workspace and its lock are gone (removed with RHDH `3ac14d77`), so the `dynamic-plugins/yarn.lock` steps above do not apply there; the root `resolutions` still do. On the 1.54 line the root `resolutions` have no `http-proxy-middleware`, `picomatch` or `ws` entry: `git log -S` finds none of them in the history of `package.json`, so they were never root pins. `yarn.lock` there resolves `http-proxy-middleware` to 2.x only, `picomatch` to 2.x and 4.x, and `ws` to 8.21.0. The `multer` pin is removed on this branch because the lock resolves `multer` 2.4.0 without it. The `vm2` pin is removed too: `yarn why vm2` prints nothing and no package in `yarn.lock` depends on `vm2`. |
| `package.json` (`resolutions`: `proxy-addr@npm:^2.0.7`, `proxy-addr@npm:~2.0.7`), `yarn.lock` | added (1.54 line) | Pins `proxy-addr` 2.0.7 to 2.0.8, the first release past GHSA-jqcg-44mw-7w3h (critical, below 2.0.8). RHDH `3ac14d77` resolves 2.0.7, so the merge brings the vulnerable version back without this pin. The keys are descriptor-scoped, so no other range moves. It stays a `package.json` pin and not a lock-only fix: a merge that takes RHDH's `yarn.lock` drops a lock-only fix, which is how 2.0.7 came back on this line. The main line removed its plain `proxy-addr` 2.0.8 resolution because it broke the offline install of the dynamic-plugin wrappers, which asked for `~2.0.7`; this line has no wrapper workspace. Drop the row when the packages that depend on `proxy-addr` ask for `^2.0.8` or later; the upstream sync is disabled on this line, so RHDH's lock moving does not remove it. |
| `python/requirements.in`, `python/requirements.txt`, `python/requirements-build.in`, `python/requirements-build.txt` (`certifi`) | modified (3.1.1) | Pins `certifi` 2024.7.4 to 2026.10.19, the first release past GHSA-6q48-6c7w-9gw2 (critical, below 2026.10.19). The TechDocs virtualenv (`/opt/techdocs-venv`) installs it, and the qualification image scan blocks 3.1.0 on it. Only the `certifi` pin and its two hashes move, taken from PyPI by hand: `pip-compile` would re-resolve the whole file under a different Python than the 3.11 the files were compiled with. RHDH `main` pruned these files on 2026-09-18 (#5451) and resolves certifi 2026.7.22, still below the fix. Drop the row when an upstream merge, or a port of that prune, brings certifi 2026.10.19 or later. |
| `package.json` (`resolutions`: `@scalprum/core`, `@scalprum/react-core`) | kept (1.54 line) | Hold `@scalprum/core` at 0.9.3 and `@scalprum/react-core` at 0.11.2, the only versions in `yarn.lock`. `packages/app/package.json` declares 0.10.3 and 0.13.3, which the lock does not contain, so the app runs the pinned versions. RHDH removed both pins in `19b99c6d`; its lock resolves 0.10.3 and 0.13.3 on `@openshift/dynamic-plugin-sdk` ^9.1.0 (`3ac14d77`). This line's lock keeps the `@openshift/dynamic-plugin-sdk` ^5.0.1 range. Removing the pins changes the plugin host runtime, so they stay as drift. Remove them when the overlays and the product face are exported with the 1.54.9 tooling and the `browser` job of `qualification.yaml` in `veecode-platform/devportal-chart` passes on a host without the pins. |
| `backstage.json` | modified (1.54 line) | Host Backstage version: `1.54.9` on this line, `1.54.6` in RHDH `3ac14d77`. Written by `scripts/update-backstage.mjs` (`yarn versions:bump`), which also rewrites `packages/app/src/build-metadata.json`. Regenerate it with the script rather than by hand. |
| `packages/app/src/build-metadata.json` | modified (1.54 line) | Build card shown by the app: the Backstage version and the time of the last bump. Written by `scripts/update-backstage.mjs` (`yarn versions:bump`) and by `scripts/update-metadata.mjs` (`yarn versions:metadata`), which reads `backstage.json`. Regenerate it with a script rather than by hand. |
| `catalog-info.veecode.yaml` | added | Backstage catalog entry for this repository (Component `devportal-core`, system `veecode-devportal`). Its upstream link says the automated sync is disabled, which matches the repository setting that disables `upstream-sync.yaml` on this line; the workflow file still carries its schedule. |
| `.github/workflows/update-versions.yaml` | modified | Inherited RHDH workflow, active but failing every run since it was forked: it minted its token from `RHDH_GITHUB_APP_ID`/`RHDH_GITHUB_APP_PRIVATE_KEY`, GitHub App secrets this fork does not hold, so `Generate token` failed and every later step was skipped (last such run 2026-09-14). Now uses `secrets.GITHUB_TOKEN` with an explicit least-privilege `permissions` block (`contents: write`, `pull-requests: write`) for the `create-pull-request` step. Same adaptation applied to `version-bump.yml` in devportal-plugins#156. Edit is confined to the token step and the added `permissions` block; the trigger set, the script invocation and the PR step are upstream's. M8 Stage 7. |
| `scripts/update-versions-doc.mjs` | modified | Inherited RHDH generator. It already honoured `GITHUB_REPOSITORY` when reading `backstage.json`, but wrote `redhat-developer/rhdh` into every link of the generated document, so a fork-run produced a doc pointing readers upstream. Now derives those links from the same `GITHUB_REPOSITORY` value (`repoUrl`) and defaults it to `veecode-platform/devportal-core`. When a documented package is not a direct dependency, it reads that package's resolved version from `yarn.lock`. M8 Stage 7. |
| `docs/dynamic-plugins/versions.md` | modified (generated) | Output of `scripts/update-versions-doc.mjs`. Regenerated against this fork: Backstage 1.52.0 (was 1.49.4, stale because the workflow above never succeeded), links resolving to this repository, and `@backstage/config-loader` at its locked version 1.10.12. Not hand-edited — regenerate rather than patch. M8 Stage 7. |
| `rulesync.jsonc` | modified (Backstage 1.54 line) | `"delete": false` where RHDH `3ac14d77` has `true`. The fork hand-writes root `AGENTS.md` and `CLAUDE.md`, which no rulesync rule generates; with `true`, rulesync 16.34.2 lists them as files to delete and `generate --check` exits 1. See the Backstage 1.54 line section. Consequence of `false`: `rulesync generate --check` can no longer flag orphaned generated files, so moving or removing a generated path needs a manual cleanup (`bed258f7` did that for `.opencode/skill/`). |
| `.rulesync/skills/devportal-release/` | added | Release skill source, in upstream's rulesync layout: carries an image through chart, index and local runner, with `scripts/release-status.sh` and `scripts/promote-image.sh`. The promotion script copies a release-candidate image to its final tag by manifest-list digest with `--preserve-digests` after release approval. Its usage and promotion section require registry push access and explain that registry-side tag immutability guards the check-then-copy race. Edit here, then run `npx rulesync@16.34.2 generate --features skills` and restore the scripts' executable bit. On the 1.54 line `rulesync.jsonc` sets `delete: false` (see the Backstage 1.54 line section), so generate leaves the hand-written `AGENTS.md` and `CLAUDE.md` in place. |
| `.claude/skills/devportal-release/`, `.cursor/skills/devportal-release/`, `.opencode/skills/devportal-release/` | added (generated) | rulesync output of the source skill row above, including the promotion script and its registry race guidance, the face-pin gate, its fixture test, and the expanded step 4 checks; never edit by hand. |
| `docs/testing.md` | modified | One bullet names the `rhdh-test-placement` skill in `redhat-developer/rhdh-skills`. Upstream still says `test-placement` in `rhdh-skill`, names that no longer exist. Drop this row when upstream fixes the bullet. |
| `.rulesync/commands/trigger-nightly-job.md` | modified | Three lines name the `rhdh-prow-trigger` skill and the `rhdh-skills` repository. Upstream still says `prow-trigger-nightly` and `rhdh-skill`, names that no longer exist. Drop this row when upstream fixes the command. |
| `.claude/commands/trigger-nightly-job.md`, `.cursor/commands/trigger-nightly-job.md`, `.opencode/commands/trigger-nightly-job.md` | modified (generated) | rulesync output of the row above (`npx rulesync@16.34.2 generate --features commands`); never edit by hand. |
| `packages/backend/package.json` + `packages/backend/src/index.ts` | modified (PR #11, `3.0.0-beta.8`) | GitLab webhook event validation: `@backstage/plugin-events-backend-module-gitlab` added to the backend deps (0.3.13 when added; 0.3.15 on this branch) and one `backend.add(...)` line appended immediately after upstream's own `plugin-events-backend` registration (index.ts:151). This branch pins `0.3.15`, next to `plugin-events-backend` 0.6.5 and `plugin-events-node` 0.4.25 (`packages/backend/package.json`). **Inert by default** — the module only activates when `events.modules.gitlab.webhookSecret` is configured, the `gitlab` HTTP topic only exists under `events.http.topics`, and no catalog provider consumes events unless configured; a deployment without those keys gets no endpoint and no behavior change. If upstream RHDH ever registers this module itself, drop our line in the sync merge. Lockfile updated via `yarn --mode=update-lockfile`. |
| `packages/backend/package.json` (`better-sqlite3`) | modified (M22 SQLFIX, unreleased) | `better-sqlite3` `12.11.1` → `13.0.3`, mirroring upstream RHDH `main` (`packages/backend/package.json`, observed at `daa81a1d076a299be159d694febbb91fb9c4886b` 2026-10-05), whose `next` image runs Node v24.19.0 with better-sqlite3 13.0.3. Fixes the Node 24.19.0 `Statement::~Statement()` teardown abort (NAN `ObjectWrap` cleanup hook) that crashes the image on start with in-memory SQLite. No divergence from upstream: same exact pin, no root `resolutions` change (upstream has none for this package). Lockfile refreshed with `yarn install` on the new pin. Drop this row once the weekly sync carries an upstream `better-sqlite3` >= 13 into this line. On the 1.54 line RHDH `3ac14d77` already pins 13.0.3, so the row does not describe a difference there. |
| Revert `418425c3` of upstream `d437e013`: `packages/backend/src/modules/authProvidersModule.ts`, `rhdhSignInResolvers.ts`, `resolverUtils.ts` (+ tests) restored; `authOwnershipModule.ts` removed again; `packages/backend/src/index.ts`, `src/modules/index.ts` and `package.json` auth wiring; `yarn.lock`; `docs/auth.md`, `docs/dynamic-plugins/override-core-services.md`, `docs/ping-identity-oidc-setup.md`; `.dockerignore`; `.ci/pipelines/resources/config_map/app-config-rhdh-rbac.yaml` (15 files, `git show --stat 418425c3`) | kept (upstream deleted them) | Upstream `d437e013` (#5258) removed the statically installed auth providers, including guest, and moved them to dynamic plugins from `rhdh-plugin-export-overlays`. The product face has no auth provider plugins, so we reverted that commit in the 2026-09-25 partial sync: without the static providers, guest, GitLab and OIDC sign-in stop working. Future upstream edits to these files arrive as modify/delete conflicts; drop this row and the revert once the face ships auth provider plugins. |
| `runs-on: ubuntu-24.04` in `pr-build-image.yaml`, `pr-podman-push.yaml`, `update-dynamic-plugins-default.yaml`, `update-rpm-lockfile.yaml`, `anchor-digest.yaml`, and the `merge` jobs of `publish-edge.yaml` and `next-build-image.yaml` | modified | GitHub moves `ubuntu-latest` to Ubuntu 26.04 from 2026-10-19 (actions/runner-images#14748). These jobs use the runner's own Podman, Buildah, Skopeo, Docker or Python, whose versions change there (Skopeo becomes a 1.21 prerelease). They stay on 24.04 until each is proven on 26.04; then the pin goes and the row with it. |

Upstream files modified outside the auth revert above: **three** — `packages/backend/package.json` and `packages/backend/src/index.ts` (one dependency + one appended `backend.add` line, see the events-module row above), and `build/containerfiles/Containerfile`, strictly **append-only**. M2 appended four blocks after the last upstream instruction (baked `dynamic-plugins.yaml`, baked `app-config.veecode.yaml`, `ENV SEGMENT_TEST_MODE=true`, and a new single-line ENTRYPOINT retyping the upstream array plus one extra `--config`). **At M4.6 (`3.0.0-beta.1`) two of those four were removed** — the baked `app-config.veecode.yaml` COPY and the retyped ENTRYPOINT, which existed only to carry it (see the `veecode/app-config.veecode.yaml` row above). Both are replaced by explanatory comment blocks, so the append-only discipline holds and the removal is legible in place. **The fork no longer overrides upstream's ENTRYPOINT at all**, which is what `entrypoint-drift.yaml` now asserts. Live drift in this file is therefore: the baked `dynamic-plugins.yaml`, `ENV SEGMENT_TEST_MODE=true`, the M3 pre-step COPY, and the baked `factory-plugins.yaml` COPY (the `dynamic-plugins.veecode.yaml` COPY of OD1 phase A is gone). A fifth block (a build-generated documentation-only vitrine at `dynamic-plugins.default.yaml`) shipped in `3.0.0-alpha.2` and was removed on 2026-08-10 (D6 reversed): that filename is a live reserved placeholder in the upstream installer contract (`includes:` entry replaced via `CATALOG_INDEX_IMAGE`), and baking a file there shadows upstream behavior. M3 front 3 (Q7) appended a sixth block: `COPY veecode/regenerate-extensions-install.js` at the WORKDIR root plus a `chmod a=r`, staged after the ENTRYPOINT with no ENTRYPOINT/CMD change of its own. OD1 phase A appended a seventh block: `COPY veecode/dynamic-plugins.veecode.yaml`, alongside the existing baked `dynamic-plugins.yaml` COPY. OD1 phase B appended an eighth block, immediately after the sixth: `COPY veecode/merge-dynamic-plugins.js` plus a `chmod a=r`, same staged-but-never-invoked shape as the regen script it sits next to. No upstream line was edited or removed; staleness of the retyped ENTRYPOINT copy is guarded by `entrypoint-drift.yaml`, which reads only the last `^ENTRYPOINT` line and is unaffected by blocks appended after it.

**On the installer-side half of OD1's fail-closed guard**: `veecode/release-1.10`'s OD1 work also patched `scripts/install-dynamic-plugins/install-dynamic-plugins.py` (a small localized diff in the `includes` resolution loop: a fatal `InstallException` when the missing include is the product-face file, plus a backstop when that file exists on disk but isn't wired into `includes` at all). That file does not exist on `veecode/main` — upstream ported the installer from Python to TypeScript (`105732db`) and then moved its consumption to an npm package (`@red-hat-developer-hub/cli-module-install-dynamic-plugins`, `1059aaaa`; see the M3.5 re-anchor note below). No equivalent patch point exists in this repo for `veecode/main` today (no `.yarn/patches` entry for that package). **Decided replacement (OD1 port, main-only)**: rather than standing up npm-patch infrastructure to recreate the Python guard, the Containerfile asserts the factory list's shape at build time instead of at boot (see the `RUN` right after the `COPY veecode/factory-plugins.yaml` line) — a grep check that the list holds names only, one path per repository and exactly four protected entries, failing the image build otherwise. This closes the "broken/short file" and "wrong local path, silently partial face" failure modes (the latter shipped in `3.0.0-beta.3`) but not the "correct file, silently dropped from `includes:`" failure mode (the boot-time wired-backstop) — that half of OD1's guard genuinely has no equivalent on `veecode/main` today. The Helm path is separately guarded by the chart's own values-schema gate (chart 0.1.10+).

**M3.5 re-anchor** (historical; two of these blocks were later removed at M4.6,
see above): these same six blocks were ported, unchanged, onto
`veecode/main`'s Containerfile — upstream's ENTRYPOINT array and WORKDIR
(`/opt/app-root/src`) are byte-identical between `release-1.10` and `main`,
so the port was a straight copy. `veecode/main` is now the
product/image-building branch (`3.0.0-alpha.5`+ ≡ `:edge`); the
`veecode/release-1.10` Containerfile is untouched and frozen at
`3.0.0-alpha.4`. One thing changed underneath the port: on `veecode/main`,
`install-dynamic-plugins.sh` is generated by the npm package
`@red-hat-developer-hub/cli-module-install-dynamic-plugins` (0.4.1 since the
2026-09-25 partial sync on `main`; 0.5.0 on the 1.54 line), not the
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

## Backstage 1.54 line

`feat/backstage-1.54` carries Backstage 1.54.9 on top of upstream RHDH `3ac14d77`, the last RHDH commit on the old
frontend system. The rows above that name this line describe its state.

- **Merge and bump.** `cc0b391e` merges `3ac14d77` (Backstage 1.54.6). It brings the UBI10 base, the removal of the
  local dynamic-plugin wrappers with `dynamic-plugins/yarn.lock`, the installer move from 0.4.1 to 0.5.0, and keeps
  our revert of RHDH's login-provider change. `8693774c` regenerates `yarn.lock`; `4d8d8ddb` bumps `backstage.json`
  to 1.54.9. Among direct dependencies only `@backstage/plugin-auth-node` moves (0.7.4 to 0.7.5).
- **RBAC moves as a pair.** `@backstage-community/plugin-rbac-backend` goes from 7.12.5 to 8.1.4 on this line, with
  `plugin-rbac-node` 2.1.1 in `packages/backend` and `plugin-rbac-common` 2.1.1 in `plugins/licensed-users-info-backend`.
  The RBAC frontend 2.3.1 and rbac-backend 8.1.4 move together: rbac-backend 8 refuses the conditional-policy writes of
  frontend 1.52.4, and frontend 2.3.1 writes conditions that rbac-backend 7.12.5 refuses. The frontend pin, which the catalog index
  carries for the factory plugins, has to move with them; until it does, the image runs frontend 1.52.4 against
  backend 8.1.4. `@red-hat-developer-hub/backstage-plugin-translations-backend` stays at 0.3.1, its `3ac14d77` version,
  and is independent of the pair.
- **Pre-step pin.** `4c4b6202` moves the config-loader pin in `.github/workflows/veecode-prestep-test.yaml` to
  `@backstage/config-loader@1.11.2`.
- **Base images and headers.** `768562a4` moves both base images to the 10.2 builds that ship Node.js 24.21.0, and
  `9a17d86d` moves `.nvmrc` and `.nvm/releases/` to match. The Containerfile skeleton stage fails unless the headers
  tarball matches `node --version`, so these files must move together. `215862d0` regenerates `rpms.lock.yaml`.
- **Upstream sync.** RHDH `main` is new-frontend-only after `3ac14d77`, so the weekly sync stops there.
  `upstream-sync.yaml` stays disabled (`disabled_manually` on 2026-10-13).
- **rulesync.** `rulesync.jsonc` sets `"delete": false`, where RHDH `3ac14d77` has `true`. The fork hand-writes root `AGENTS.md` and `CLAUDE.md`, and with `true` rulesync 16.34.2 deletes both on `generate`, so `generate --check` in `rulesync-check.yaml` fails. Main ran rulesync 7.30.0 and watched only the generated paths, so the deletion never showed there. With `false`, `doctor --strict` and `generate --check` pass; `generate` still warns three times that no root rule file exists (cursor, claudecode, opencode), and those warnings do not fail it. Do not run `generate` with `delete` set back to `true`.
- **Versions page.** `docs/dynamic-plugins/versions.md` still says Backstage 1.52.0 on this line. `scripts/update-versions-doc.mjs` accepts only `main` and `release-*` as its branch argument, and it writes that branch into every link, so it cannot produce this line's page yet.
- **Hermetic image build.** The first dry run of this line (`publish-edge.yaml` with `publish=false`, run 38458777060 on `8be83fc7`) failed on arm64 because hermeto `:latest` moved to 0.63.0, which ships amd64 only. The docker-build row records the pin that replaces it.

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
  the `release-1.10` copy remains but its line is frozen at `3.0.0-alpha.4`. Correction (2026-10-13): run 38454876059 dispatched a workflow that exists only on its own branch with `--ref`, so the dispatch part of this bullet does not hold. Schedules still need the default branch.

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

Since the 2026-08-26 rename, `main` is the product branch, so every inherited
workflow that filters on `main` fires on our pushes and pull requests. The
image-building and PR-opening ones are disabled with `gh workflow disable`.
State read from `GET /repos/veecode-platform/devportal-core/actions/workflows`
on 2026-09-25:

- **Disabled:** `next-build-image.yaml` (it still targets
  `quay.io/rhdh-community/rhdh` and listens to pushes on `main`),
  `pr-build-image.yaml`, `pr-podman-push.yaml`, `pr.yaml`,
  `e2e-cluster-free.yaml`, `update-backstage.yaml`,
  `update-rpm-lockfile.yaml`, `auto-approve-bot-prs.yaml`,
  `coverage-baseline.yml`, `link-checker.yaml`, `stale.yaml`,
  `sync-owners-aliases.yaml`, and, since 2026-09-25, the VeeCode
  `upstream-sync.yaml` (disabled; on the 1.54 line the sync stops at RHDH `3ac14d77`).
- **Active:** the VeeCode workflows (`publish-edge.yaml`, `anchor-digest.yaml`,
  `entrypoint-drift.yaml`, `secret-scan.yaml`) and the
  inherited `cache-cleanup.yaml`, `codeql.yaml`, `pr-semantic.yaml` and
  `update-versions.yaml`.

Never re-enable `next-build-image.yaml` or the PR image pair without first
pointing them at a VeeCode registry: they would build from `main` and push
under the upstream namespace.

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
