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

- `veecode/` holds the product face (`dynamic-plugins.veecode.yaml`), the
  baked plugin defaults and the install pre-steps. The image build fails if the
  face does not have exactly 20 entries or a local entry has no built directory.
- `dynamic-plugins/` is the wrapper workspace for plugins the face installs from
  local builds.
- `backstage.json` is the host Backstage version. `devportal-plugins`
  workspaces track it and may not lead it.

## Invariants

- The face keeps exactly 20 entries, and every local entry resolves to a built
  directory. The build enforces it because `3.0.0-beta.3` shipped a silently
  partial face: five local refs lacked the `-dynamic` suffix and the installer
  skipped them with a warning.
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

## Release path

`publish-edge.yaml` with `publish=true` pushes the immutable version tag and
moves `:edge` to the same digest. The chart then moves `appVersion`, the image
tag and the digest together in `veecode-platform/devportal-chart`, whose CI
rejects a mismatch.

## Upstream sync

`upstream-sync.yaml` merges upstream `main` into `main` every Monday and opens
an issue when the merge conflicts. Resolve the conflict by following
`docs/upstream-drift.md`; never force-push `main`.
