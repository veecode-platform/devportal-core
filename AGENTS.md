# Agent Guidelines

This repository is the VeeCode DevPortal image, a fork of
[redhat-developer/rhdh](https://github.com/redhat-developer/rhdh). It builds
`docker.io/veecode/devportal` from `main`.

Read [docs/upstream-drift.md](docs/upstream-drift.md) before changing any file
that also exists upstream, and add a row to its table in the same change. A
change that is not in that table can disappear in the next upstream merge.
Mission context and platform vocabulary live in
[devportal-planning](https://github.com/veecode-platform/devportal-planning).

## What is ours

- `veecode/` holds the factory plugin list (`factory-plugins.yaml`, names only),
  the baked plugin defaults and the install pre-steps. The image build fails if
  the list carries a package ref or does not mark exactly four entries protected.
- `dynamic-plugins/` is not on the 1.54 line: RHDH `3ac14d77` removed the wrapper
  workspace and its local plugin wrappers.
- `backstage.json` is the host Backstage version. `devportal-plugins`
  workspaces track it and may not lead it.

## Invariants

- The factory list holds names only. The catalog index enables those plugins and
  owns their versions and config, so a plugin update is an index republish, not
  an image build.
- This repository never publishes `latest`, `stable` or `2.x` tags. Those
  belong to the 2.x publisher in `devportal-platform`, which writes the same
  Docker Hub repository; `publish-edge.yaml` rejects them.
- Edits to upstream files stay small and additive. A clean upstream merge does
  not prove that a VeeCode change survived it; check the rendered result.

## Verify a change

The image builds hermetically, so a plain `docker build` fails. Build without
publishing through the real pipeline:

```bash
gh workflow run publish-edge.yaml --ref <branch> -f publish=false -f version=<any>
```

`scripts/local-hermeto-build.sh` builds locally; it needs podman.

To prove a change in a running portal before it merges, publish a candidate
that leaves `:edge` alone, then run the chart qualification on it (install,
Marketplace, upgrade, broken package, restart, rollback, browser specs and
image scan):

```bash
gh workflow run publish-edge.yaml --ref <branch> -f publish=true -f move_edge=false -f version=<next>-pr<N>.<short-sha>
gh workflow run qualification.yaml -R veecode-platform/devportal-chart --ref main -f image_tag=<next>-pr<N>.<short-sha>
```

## Release path

Cut a release with the `devportal-release` skill
(`.rulesync/skills/devportal-release/`); it walks every hop below and checks
the end state.

`publish-edge.yaml` with `publish=true` pushes the immutable version tag and
moves `:edge` to the same digest. The chart then moves `appVersion`, the image
tag and the digest together in `veecode-platform/devportal-chart`, whose CI
rejects a mismatch.

## Upstream sync

`upstream-sync.yaml` merges upstream `main` into `main` every Monday and opens
an issue when the merge conflicts. It stays disabled on the Backstage 1.54 line:
RHDH `main` is new-frontend-only after `3ac14d77`, so the sync stops there, and
the next upstream move is the new frontend system, planned for v4. Resolve a
conflict by following `docs/upstream-drift.md`; never force-push `main`.
