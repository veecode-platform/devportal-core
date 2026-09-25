#!/usr/bin/env bash
# Show where a DevPortal image release stands in every repository that consumes it.
#
#   release-status.sh <image-version> <chart-version>
#   release-status.sh 3.0.0-beta.9 0.1.24
#
# Read-only. Prints one line per node and exits 1 when any node is missing or
# disagrees with the image digest, so a release that stopped halfway is visible.
set -uo pipefail

IMAGE_VERSION=${1:?usage: release-status.sh <image-version> <chart-version>}
CHART_VERSION=${2:?usage: release-status.sh <image-version> <chart-version>}
ORG=veecode-platform
IMAGE_REPO=veecode/devportal
PAGES_INDEX=https://veecode-platform.github.io/next-charts/index.yaml

failures=0
report() {
  local state=$1; shift
  printf '[%s] %s\n' "$state" "$*"
  case $state in ok|info|skip) ;; *) failures=$((failures + 1)) ;; esac
}

repo_file() {
  gh api "repos/$ORG/$1/contents/$2?ref=$3" --jq .content 2>/dev/null | base64 -d 2>/dev/null
}

hub_tag() {
  curl -fsS "https://hub.docker.com/v2/repositories/$IMAGE_REPO/tags/$1" 2>/dev/null
}

tag_json=$(hub_tag "$IMAGE_VERSION")
if [ -z "$tag_json" ]; then
  report missing "image docker.io/$IMAGE_REPO:$IMAGE_VERSION does not exist"
  echo "Nothing downstream can be checked without the image."
  exit 1
fi
DIGEST=$(jq -r .digest <<<"$tag_json")
archs=$(jq -r '[.images[].architecture] | sort | join(",")' <<<"$tag_json")
if [ "$archs" = "amd64,arm64" ]; then
  report ok "image $IMAGE_VERSION = $DIGEST (amd64,arm64)"
else
  report drift "image $IMAGE_VERSION = $DIGEST, but architectures are '$archs' (want amd64,arm64)"
fi

edge=$(hub_tag edge | jq -r '.digest // empty')
if [ "$edge" = "$DIGEST" ]; then
  report ok ":edge points at $IMAGE_VERSION"
else
  report info ":edge is $edge, not $IMAGE_VERSION (fine only if a newer image was published on purpose)"
fi

check_chart_ref() {
  local ref=$1 label=$2 values chart tag digest app version
  values=$(repo_file devportal-chart charts/backstage/values.yaml "$ref")
  chart=$(repo_file devportal-chart charts/backstage/Chart.yaml "$ref")
  if [ -z "$values" ] || [ -z "$chart" ]; then
    report missing "devportal-chart $label: cannot read the chart at $ref"
    return
  fi
  tag=$(awk '/^  backstage:/{b=1} b&&/^      tag:/{print $2; exit}' <<<"$values")
  digest=$(awk '/^  backstage:/{b=1} b&&/^      digest:/{print $2; exit}' <<<"$values")
  app=$(awk -F': ' '$1=="appVersion"{print $2; exit}' <<<"$chart")
  version=$(awk -F': ' '$1=="version"{print $2; exit}' <<<"$chart")
  if [ "$tag" = "$IMAGE_VERSION" ] && [ "$digest" = "$DIGEST" ] && [ "$app" = "$IMAGE_VERSION" ] && [ "$version" = "$CHART_VERSION" ]; then
    report ok "devportal-chart $label: version $version pins $IMAGE_VERSION by tag, digest and appVersion"
  else
    report drift "devportal-chart $label: version=$version tag=$tag appVersion=$app digest=$digest"
  fi
}

check_chart_ref main "main"

if gh api "repos/$ORG/devportal-chart/git/ref/tags/chart-v$CHART_VERSION" >/dev/null 2>&1; then
  check_chart_ref "chart-v$CHART_VERSION" "tag chart-v$CHART_VERSION"
  assets=$(gh release view "chart-v$CHART_VERSION" -R "$ORG/devportal-chart" --json assets --jq '[.assets[].name] | join(",")' 2>/dev/null)
  if grep -q "devportal-$CHART_VERSION.tgz" <<<"$assets"; then
    report ok "devportal-chart release chart-v$CHART_VERSION has devportal-$CHART_VERSION.tgz"
  else
    report missing "devportal-chart release chart-v$CHART_VERSION has no packaged chart (assets: ${assets:-none})"
  fi
else
  report missing "devportal-chart tag chart-v$CHART_VERSION does not exist"
fi

index_versions=$(curl -fsS "$PAGES_INDEX" 2>/dev/null \
  | python3 -c 'import sys, yaml; print("\n".join(e["version"] for e in yaml.safe_load(sys.stdin)["entries"].get("devportal", [])))' 2>/dev/null)
if grep -qx "$CHART_VERSION" <<<"$index_versions"; then
  report ok "next-charts index serves devportal $CHART_VERSION"
else
  report missing "next-charts index does not serve devportal $CHART_VERSION (newest: $(sort -V <<<"$index_versions" | tail -1))"
fi

pin=$(repo_file devportal-local .chart-pin main | tr -d ' \n\r')
if [ "$pin" = "chart-v$CHART_VERSION" ]; then
  report ok "devportal-local .chart-pin = $pin"
else
  report drift "devportal-local .chart-pin = ${pin:-unreadable} (want chart-v$CHART_VERSION)"
fi
for compose in docker-compose.yml docker-compose.dynamic-plugins-root.yml docker-compose.rbac-lab.yml; do
  body=$(repo_file devportal-local "$compose" main)
  [ -n "$body" ] || continue
  others=$(grep -oE "$IMAGE_REPO@sha256:[0-9a-f]{64}" <<<"$body" | sort -u | grep -v "$DIGEST")
  if grep -q "$IMAGE_REPO@$DIGEST" <<<"$body" && [ -z "$others" ]; then
    report ok "devportal-local $compose defaults to $IMAGE_VERSION"
  elif grep -qE "$IMAGE_REPO@sha256" <<<"$body"; then
    report drift "devportal-local $compose pins another image: $(tr '\n' ' ' <<<"$others")"
  fi
done

smoke=$(repo_file devportal-local docker-compose.yml main | grep -o -m1 'DEVPORTAL_IMAGE:-[^}]*' | sed 's/^DEVPORTAL_IMAGE:-//')
if [ "$smoke" = "docker.io/$IMAGE_REPO@$DIGEST" ]; then
  report ok "overlay smoke tests resolve $IMAGE_VERSION (they read devportal-local's compose)"
else
  report drift "overlay smoke tests resolve ${smoke:-nothing}"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "Release $IMAGE_VERSION / chart $CHART_VERSION is consistent everywhere checked."
else
  echo "$failures node(s) missing or out of step."
fi
[ "$failures" -eq 0 ]
