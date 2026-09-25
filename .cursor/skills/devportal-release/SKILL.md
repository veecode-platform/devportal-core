---
name: devportal-release
description: 'Cut a new DevPortal image (docker.io/veecode/devportal 3.x) and carry it through every repository that consumes it: chart, chart index, local runner and overlay smoke tests. Use when a change on devportal-core main has to reach a running portal.'
---
# DevPortal release

A new portal image is not done when it is pushed. Five repositories each pin it, and half of the hops are
manual. A release that stops halfway leaves the chart, the local runner and the overlay smoke tests on different
images without anyone noticing. Carry every release through the whole graph in one
pass, and prove the end state with `scripts/release-status.sh`.

## The graph

| # | Node | What moves it | Manual? |
| - | ---- | ------------- | ------- |
| 1 | `devportal-core` image `docker.io/veecode/devportal:<version>` and `:edge` | `publish-edge.yaml`, `workflow_dispatch` | yes |
| 2 | `devportal-chart` `charts/backstage` (image `tag` + `digest`, `appVersion`, `version`) | a PR, then tag `chart-v<version>`, which runs `publish-chart-release.yml` | yes |
| 3 | `next-charts` Helm index (`https://veecode-platform.github.io/next-charts`) | `ingest-devportal-chart.yml`, `workflow_dispatch` | yes |
| 4 | `devportal-local` `.chart-pin` and compose image digests | `chart-bump.yml` opens a PR (nightly, or dispatch it) | merge only |
| 5 | `devportal-plugin-export-overlays` smoke tests | read the image from devportal-local's `main` compose | no |

Plugins do not move. They are OCI artifacts tagged `bs_<backstage>__<version>`, and the catalog index uses the
moving tag `bs_<backstage>`. Both stay valid while the image keeps the same Backstage line.

## Before you start

1. **Pick the versions.** The image takes the next free `3.0.0-beta.N`. The chart takes the next unreleased
   `version`. If `Chart.yaml` on `main` already carries a version that has no `chart-v*` tag, reuse it rather
   than skip a number.
2. **See where the last release stands.** Run `scripts/release-status.sh <current-image> <current-chart>`. Fix or
   finish any drift it shows first, because this release inherits it.
3. **Check the Backstage line.** `backstage.json` on `devportal-core` `main` must match the running line (1.52.0
   today). Knex migrations only move forward, so an image from an older line cannot boot on a database a newer one
   migrated.
4. **Check the face pins.** Run `scripts/check-face-pins.sh main`. It confirms the face has the 20 entries the
   Containerfile gate requires, and that every OCI digest the face pins still exists on quay. A garbage-collected
   pin aborts the installer, and the pod never leaves init.
5. **Know what ships.** List the commits since the previous image. The last `publish-edge.yaml` run's `headSha`
   marks it, because the workflow creates no git tag:
   `gh run list -R veecode-platform/devportal-core -w publish-edge.yaml -L 3 --json headSha,createdAt`.

## 1. Publish the image

```sh
gh workflow run publish-edge.yaml -R veecode-platform/devportal-core --ref main \
  -f version=<version> -f publish=true
```

The run takes about 30 minutes. It builds amd64 and arm64 and pushes `<version>`. It moves `:edge`, and it
asserts that both tags share one manifest-list digest. It then tags every face pin on quay as
`face-<version>-<digest>`, so quay cannot collect them. It never writes `:latest`, `:stable` or `2.x`, which stay
frozen on the 2.x line (ADR-012).

**Done when** the run is green, and `release-status.sh` shows the image with both architectures and `:edge`
pointing at it. Record the digest. Every later hop pins it.

`:edge` moves the moment this finishes, so anyone who opted into it gets the image at once. `next-build-image.yaml`
is upstream's nightly build to `quay.io/rhdh-community/rhdh` and is disabled in the fork. Nothing else publishes
an image.

## 2. Prove the image before any consumer points at it

Run `devportal-local` `main`, on a machine meant for booting the stack, with `DEVPORTAL_IMAGE=docker.io/veecode/devportal@<digest>`. Confirm
all of these:
- the installer installs every face entry;
- the portal reaches readiness;
- there is no `Cannot find module` and no `already registered`;
- the pages the release changed work.

Run the same check on the previous image for comparison. An independent verifier should run it, not the person
who cut the release.

## 3. Release the chart

One PR in `devportal-chart`:
- in `charts/backstage/values.yaml`, set `upstream.backstage.image.tag` and `upstream.backstage.image.digest`
  together, and update the comment above them. The digest wins over the tag, so a PR that moves only the tag moves
  nothing. The digest must be the multi-arch manifest-list digest, not a single-architecture one;
- in `charts/backstage/Chart.yaml`, set `version` and `appVersion`, and add a line to the version history comment;
- in `charts/backstage/README.md`, update the badges the way helm-docs generates them (pre-commit runs it).

Get an independent verdict on the PR, then merge it with a merge commit. Tag the merge commit and push the tag:

```sh
git tag chart-v<chart-version> <merge-commit> && git push origin chart-v<chart-version>
```

`publish-chart-release.yml` fails unless the tag matches `Chart.yaml`. It creates the GitHub release with
`devportal-<chart-version>.tgz` and its checksum.

**Done when** `release-status.sh` shows both `main` and the tag pinning the image, and shows the release asset.

## 4. Publish the chart to the Helm index

```sh
gh workflow run ingest-devportal-chart.yml -R veecode-platform/next-charts -f version=<chart-version>
```

It downloads the release asset and verifies its checksum. It commits the package to `next-charts` `main` and
dispatches `release-charts.yml`, which rebuilds the index. Helm users see nothing until this step runs.

**Done when** `release-status.sh` shows the index serving the version. GitHub Pages can lag by a few minutes.

## 5. Move the local runner

```sh
gh workflow run chart-bump.yml -R veecode-platform/devportal-local
```

Dispatch it rather than wait for the nightly run. It opens `chore: pin devportal-chart chart-v<chart-version>`,
which moves `.chart-pin` and the composes' default digest. It does not touch the version named in the compose
comments and in `README.md`, so push a commit to the same branch that updates them. Search for the old chart
version, the old image version and the old digest; none should remain.

`config-drift.yml` and `nightly-health.yml` run on the PR. Because a bot opened it, their first runs wait at
`action_required`. A commit pushed by a person starts them, and so does approving the runs in the Actions tab.
Merge the PR after both pass, including the `boot` job, and after an independent verdict.

**Done when** `release-status.sh` shows the pin and every compose on the new image. The overlay smoke-test line
turns green at the same moment, with nothing to do in that repository.

## 6. Downstream installations

Installations that pin a chart version, such as customer and internal deployments, move in their own
repositories and follow their own runbooks. This skill ends when the index serves the chart.

## Finish

Run `release-status.sh` one last time and keep its output in the release notes or the PR that closes the release.
Then remove what the release left behind:
- the worktrees and branches, after checking each is merged;
- the scratch directories, compose projects and pulled images on the build machine.

## Traps

- **The chart's digest wins over its tag.** Chart 0.1.22 moved only the tag, and the portal kept running the old
  image.
- **A tag whose `appVersion` lags looks fine until `helm list` reports the wrong version.** Chart 0.1.23 is an
  example, and `release-status.sh` flags it.
- **Face pins die when quay garbage-collects.** The pod that is already running hides it until the next restart.
  Step 1 anchors the pins, and the pre-flight checks them.
- **`ct lint` wants a version bump for every chart change.** The chart's lint job also runs
  `hack/check-image-pin.py`, which fails a PR whose `appVersion`, image tag and served digest disagree.
- **The image comes from `main`.** Confirm the branch and the Backstage line before publishing. Beta.2 came from the
  wrong branch and was a Backstage downgrade.
