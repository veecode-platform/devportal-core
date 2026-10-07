---
name: devportal-release
description: >-
  Cut a new DevPortal image (docker.io/veecode/devportal 3.x) and carry it
  through every repository that consumes it: qualification, promotion, chart,
  chart index, local runner, overlay smoke tests and the release sheet. Also
  covers a fix that lives in a product-face plugin. Use when a change on
  devportal-core main, or a rebuilt face plugin, has to reach a running portal.
---
# DevPortal release

A new portal image is not done when it is pushed. Several repositories pin it, and a release that stops halfway
leaves the chart, the local runner, the overlay smoke tests and the docs on different images without anyone
noticing. Carry every release through the whole graph in one pass, and prove the end state with
`scripts/release-status.sh`.

The flow follows RHDH's pattern: the candidate image is qualified before any chart pins it, there is no release
candidate chart, the chart pull request only moves version fields, and the qualification of the published package
runs after the release without blocking it. One go-ahead per release covers the promotion, the chart, the index,
the local runner and the docs.

Script paths are relative to this skill's folder. From the repository root they are
`.claude/skills/devportal-release/scripts/` (the source copy is `.rulesync/skills/devportal-release/scripts/`).

## The graph

| # | Node | What moves it | Typical time |
| - | ---- | ------------- | ------------ |
| 1 | `devportal-core` candidate `docker.io/veecode/devportal:<version>-rc.N` and `:edge` | `publish-edge.yaml`, `workflow_dispatch` | 20–27 min |
| 2 | Qualification of the candidate image | `devportal-chart` `qualification.yaml` with `image_tag` | 22 min |
| 3 | Final tag `<version>` | `promote-image.yaml`, `workflow_dispatch` | 1 min |
| 4 | `devportal-chart` `charts/backstage` (version fields only) | a PR, then tag `chart-v<version>`, which runs `publish-chart-release.yml` | 15 min of checks |
| 5 | `next-charts` Helm index (`https://veecode-platform.github.io/next-charts`) | `ingest-devportal-chart.yml`, `workflow_dispatch` | 2–5 min |
| 6 | Qualification of the published package (non-blocking) | `qualification.yaml` with `chart_version` | 23 min, in parallel |
| 7 | `devportal-local` `.chart-pin`, compose digests and version mentions | `chart-bump.yml` opens a PR (nightly, or dispatch it) | a few minutes |
| 8 | `devportal-plugin-export-overlays` smoke tests | read the image from devportal-local's `main` compose | none |
| 9 | Release sheet and install pages in `veecode-platform/docs` | a PR to `main` | 5 min of checks |

Plugins move only when the release is about them; see "When the fix lives in a face plugin". They are OCI
artifacts tagged `bs_<backstage>__<version>`, and the catalog index uses the moving tag `bs_<backstage>`.

## Before you start

1. **Pick the versions.** The image takes the next patch, built first as `<version>-rc.1`. The chart takes the next
   unreleased `version`. If `Chart.yaml` on `main` already carries a version that has no `chart-v*` tag, reuse it
   rather than skip a number.
2. **See where the last release stands.** Run `scripts/release-status.sh <current-image> <current-chart>`. Fix or
   finish any drift it shows first, because this release inherits it.
3. **Check the Backstage line.** `backstage.json` on `devportal-core` `main` must match the running line (1.52.0
   today). Knex migrations only move forward, so an image from an older line cannot boot on a database a newer one
   migrated.
4. **Check the face pins.** Run `scripts/check-face-pins.sh main` (set `FACE_FILE` to check an edited face before it
   merges). The gate gets the catalog-index image, checks that all 20 face digests exist and that no face repository
   appears in the index's `dynamic-plugins.default.yaml`, and for each face entry with a catalog Package compares the
   Package digest with the face digest and `spec.version` with the artifact annotation. The `veecode-theme` entry has
   no catalog Package, so the gate compares its face digest with the source tag in its `# was :<tag>` comment. It
   needs GitHub and Quay access and `gh`, `yq`, `skopeo`, `jq`, `curl`, `base64` and `tar`.
5. **Know what ships.** List the commits since the previous image. The last `publish-edge.yaml` run's `headSha`
   marks it, because the workflow creates no git tag:
   `gh run list -R veecode-platform/devportal-core -w publish-edge.yaml -L 3 --json headSha,createdAt`.
   The nightly Qualification on `:edge` (04:17 UTC) shows whether `main` already qualifies.

## 1. Build the candidate image

```sh
gh workflow run publish-edge.yaml -R veecode-platform/devportal-core --ref main \
  -f version=<version>-rc.1 -f publish=true
```

It builds amd64 and arm64, pushes `<version>-rc.1`, moves `:edge`, and asserts that both tags share one
manifest-list digest. It tags every face pin on quay as `face-<version>-<digest>`, so quay cannot collect them. It
never writes `:latest`, `:stable` or `2.x`, which stay frozen on the 2.x line (ADR-012). The hermeto dependency
prefetch is cached by the lockfiles, so a build whose dependencies did not change skips it.

`publish=false` builds without pushing; use it on a branch to try a build change.

**Done when** the run is green. Record the manifest-list digest; every later hop pins it.

## 2. Qualify the candidate

```sh
gh workflow run qualification.yaml -R veecode-platform/devportal-chart --ref main -f image_tag=<version>-rc.1
```

The run resolves the tag to a digest once and installs the chart at `main` with that image on KinD: the browser
specs, the install, restart, upgrade from the previous final chart, broken package and rollback sequence, and the
vulnerability scans. The image scan blocks on a critical vulnerability with a fix and no live exception
(`.trivyignore.yaml`); the scan of the face's OCI plugin artifacts only reports.

**Done when** the run is green. Download its artifacts: `qualification-sequence/qualification-manifest.json` (image
digest, candidate chart, catalog index digest), `qualification-scan/scan-summary.md` and
`qualification-scan/face-defaults/summary.md` feed the release sheet. A red run means a new candidate
(`-rc.2`), not a retry of the chart.

## 3. Promote the candidate

```sh
gh workflow run promote-image.yaml -R veecode-platform/devportal-core --ref main \
  -f candidate=<version>-rc.N -f final=<version>
```

It runs `scripts/promote-image.sh`: it refuses an existing final tag and a candidate that is not a
multi-architecture manifest list, copies by digest with `skopeo copy --all --preserve-digests`, and checks that the
final tag resolves to the candidate's digest. Nothing is rebuilt.

**Done when** `skopeo inspect --raw docker://docker.io/veecode/devportal:<version> | sha256sum` equals the
candidate digest.

## 4. Release the chart

One PR in `devportal-chart` that moves only version fields:
- `charts/backstage/values.yaml`: `upstream.backstage.image.tag` and `upstream.backstage.image.digest` together, and
  the comment above them. The digest wins over the tag, and it must be the multi-arch manifest-list digest;
- `charts/backstage/values.schema.json`: the defaults for that tag **and** that digest (pre-commit fails on a stale
  digest default);
- `charts/backstage/Chart.yaml`: `version`, `appVersion`, and a line in the version history comment;
- `charts/backstage/README.md`: the version badge and the `helm install --version` line.

The PR's checks: lint and `hack/check-image-pin.py`, pre-commit, the eight install scenarios in parallel (one job
per `ci/*-values.yaml`, each with the upgrade path), and Qualification. Qualification skips itself when an
`image_tag` run on `main` already qualified this digest with the same chart (`qualification/prior-qualification.sh`;
the job summary links that run). Anything beyond the version fields makes it qualify again.

Merge with a merge commit, then tag and push:

```sh
git tag -a chart-v<chart-version> <merge-commit> -m "devportal chart <chart-version> (DevPortal <version>)"
git push origin chart-v<chart-version>
```

`publish-chart-release.yml` fails unless the tag matches `Chart.yaml`, and creates the GitHub release with
`devportal-<chart-version>.tgz` and its checksum.

**Done when** `release-status.sh` shows both `main` and the tag pinning the image, and shows the release asset.

## 5. Publish the chart to the Helm index

```sh
gh workflow run ingest-devportal-chart.yml -R veecode-platform/next-charts -f version=<chart-version>
```

It downloads the release asset, verifies its checksum, commits the package and dispatches `release-charts.yml`.
Pages deploys a minute later. `next-charts` also serves `veecode-devportal`, so match `next-charts/devportal-<v>.tgz`,
not `devportal-<v>.tgz`, when you grep the index.

**Done when** `helm show chart veecode/devportal --version <chart-version>` resolves after `helm repo update`, and
the served package's `sha256sum` equals the release's `.sha256`.

## 6. Qualify the published package, in parallel

```sh
gh workflow run qualification.yaml -R veecode-platform/devportal-chart --ref main -f chart_version=<chart-version>
```

It does not block steps 7 and 8. A red result opens an incident and a patch release.

## 7. Move the local runner

```sh
gh workflow run chart-bump.yml -R veecode-platform/devportal-local
```

It opens `chore: pin devportal-chart chart-v<chart-version>`, which moves `.chart-pin` and the composes' default
digest, and dispatches `config-drift.yml`, `scripts-test.yml` and `nightly-health.yml` on the PR branch. Those runs
do not show as PR checks (the bot's own `pull_request` runs stay at `action_required`); read them with
`gh run list -R veecode-platform/devportal-local -b chore/chart-pin-chart-v<chart-version>`.

It does not touch the version named in the `docker-compose.yml` comments and in `README.md`. Push a commit to the same
branch that updates them, and search for the old chart version, image version and digest; none should remain.

**Done when** the dispatched runs are green, the PR is merged, and `release-status.sh` shows the pin and every
compose on the new image. The overlay smoke-test line turns green at the same moment.

## 8. Write the release sheet

One PR to `veecode-platform/docs` `main`:
- `devportal/v3/release-sheets/release-sheet-<x-y-z>.md`, copied from the previous sheet with the next
  `sidebar_position`, and filled from step 2's artifacts: image and digest, chart and its checksum, the qualified
  catalog index digest and its timestamped tag (`bs_<backstage>_<timestamp>` that points at that digest), the
  Kubernetes and PostgreSQL versions, the scan table, the exceptions and the face plugin table;
- `devportal/v3/release-sheets/release-sheets.md`: the new sheet on top;
- the version moves in `devportal/v3/intro.md`, `devportal/v3/upgrade.md` (the `FROM`/`TO` variables, digests
  included), `devportal/v3/support.md` and `devportal/migrating-from-2x.md`;
- a known-issue line in the previous sheet when this release fixes something it shipped.

A merge to `main` deploys production and publishes `@veecode-platform/docs-mcp`. Broken links fail the build.

**Done when** the production pages show the new digest, chart checksum and stable version.

## 9. Downstream installations

Installations that pin a chart version, such as customer and internal deployments, move in their own
repositories and follow their own runbooks. This skill ends when the index, the local runner and the docs serve
the release.

## When the fix lives in a face plugin

The face (`veecode/dynamic-plugins.veecode.yaml`) pins its OCI plugins by digest inside the image, so a rebuilt
plugin reaches installations only through a new image that pins the new digest.

1. **Fix it in the overlay.** For a dependency inside its existing range, add a `yarn.lock` patch to the workspace's
   `patches/` (generated with `yarn up -R <pkg> --mode=update-lockfile` on the patched source; the format omits
   `diff --git`, so it applies with `patch -p0`). A plugin we own can instead take a version bump at its source.
2. **Prove it before merging.** Dispatch `publish-workspace-plugins.yaml` from a branch per workspace (the workflow
   cancels a concurrent run on the same ref) with `-f rc-tag-suffix=-rc.<name> -f workspace-path=workspaces/<ws>
   -f also-publish-plugins=true`. `Validate Catalog Metadata` fails on that path because the metadata points at the
   release tag, but the per-plugin candidate images are already pushed; scan them by digest.
3. **Get the release tags.** The per-plugin tag is the plugin version and is immutable (ADR-008): the publish
   skips a tag that exists, so a rebuild with the same version publishes nothing. Either the plugin version changes,
   or Gio approves an exception: `delete-plugin-tags.yaml` in the overlays (dry run first; it checks each tag's
   digest and that a `face-*`/`anchor-*` tag keeps it alive), a row in ADR-008's exception table, then a publish.
   A scoped dispatch skips workspaces unchanged since the last published commit; touch the workspace's
   `plugins-list.yaml` comment in a PR to make the push publish them. The overlays' `check-catalog-packages` fails
   while a deleted tag is missing; publish from that PR's branch first, then rerun the check. Never merge over it.
4. **Move the face.** Replace the digests in `veecode/dynamic-plugins.veecode.yaml`, keep the `# was :<tag>`
   comments, and run `FACE_FILE=veecode/dynamic-plugins.veecode.yaml scripts/check-face-pins.sh main`. Then release
   the image from step 1.

## Finish

Run `release-status.sh` one last time and keep its output in the release notes or the PR that closes the release.
Then remove what the release left behind: the worktrees and branches, after checking each is merged, and the
scratch directories on the build machine.

## Traps

- **The chart's digest wins over its tag.** Chart 0.1.22 moved only the tag, and the portal kept running the old
  image.
- **A tag whose `appVersion` lags looks fine until `helm list` reports the wrong version.** `release-status.sh` flags
  it.
- **Face pins die when quay garbage-collects.** Step 1 anchors them, and the pre-flight checks them.
- **A global yarn resolution breaks the hermetic build.** It rewrites the lockfile key, and the wrappers'
  `export-dynamic` runs its own `yarn install` with the old range and no network. Move a transitive dependency inside
  its range with `yarn up -R`; use a resolution only to leave the range, and only at the root.
- **The vulnerability database moves.** A released image can turn red overnight with no change; the nightly
  Qualification on `:edge` shows it first.
- **GitHub API 5xx on the release step.** Wait a few minutes and rerun the workflow once. Never create the release by
  hand: the workflow refuses a release that already has assets, and the checksum the docs record must be the
  workflow's.
- **The image comes from `main`.** Confirm the branch and the Backstage line before publishing. Beta.2 came from the
  wrong branch and was a Backstage downgrade.
