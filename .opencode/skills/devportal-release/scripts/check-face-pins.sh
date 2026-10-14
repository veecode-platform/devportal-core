#!/usr/bin/env bash
set -uo pipefail

REF=${1:-main}
FAILURES=0
PACKAGE_CHECKS=0
NO_PACKAGE_CHECKS=0
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

for required_command in gh yq skopeo jq curl base64 tar; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "missing required command: $required_command"
    exit 2
  fi
done

fail() {
  echo "[fail] $*"
  FAILURES=$((FAILURES + 1))
}

if [ -n "${FACE_FILE:-}" ]; then
  FACE_PATH=$FACE_FILE
else
  FACE_PATH=$TEMP_DIR/face.yaml
  if ! gh api "repos/veecode-platform/devportal-core/contents/veecode/dynamic-plugins.veecode.yaml?ref=$REF" --jq .content | base64 -d > "$FACE_PATH"; then
    echo "cannot read the face at devportal-core@$REF"
    exit 1
  fi
fi

ENTRY_COUNT=$(yq -er '.plugins | length' "$FACE_PATH") || { echo "cannot parse the product face"; exit 1; }
echo "devportal-core@$REF face: $ENTRY_COUNT entries (the Containerfile gate requires 20)"
[ "$ENTRY_COUNT" -eq 20 ] || fail "entry count is $ENTRY_COUNT, not 20"
mapfile -t FACE_PACKAGES < <(yq -er '.plugins[].package' "$FACE_PATH")
[ "${#FACE_PACKAGES[@]}" -eq "$ENTRY_COUNT" ] || { echo "cannot read every package ref from the product face"; exit 1; }

INDEX_IMAGE=${CATALOG_INDEX_IMAGE:-}
if [ -z "$INDEX_IMAGE" ]; then
  CHART_VALUES_B64=$(gh api repos/veecode-platform/devportal-chart/contents/charts/backstage/values.yaml --jq .content) || {
    echo "cannot read devportal-chart catalogIndex values"
    exit 1
  }
  CHART_VALUES=$(base64 -d <<<"$CHART_VALUES_B64") || { echo "cannot decode devportal-chart values"; exit 1; }
  INDEX_IMAGE=$(yq -er '"\(.global.catalogIndex.image.registry)/\(.global.catalogIndex.image.repository):\(.global.catalogIndex.image.tag)"' <<<"$CHART_VALUES") || {
    echo "cannot parse devportal-chart catalogIndex image"
    exit 1
  }
fi
echo "catalog index: $INDEX_IMAGE"

INDEX_DIR=$TEMP_DIR/index
UNPACKED_DIR=$TEMP_DIR/unpacked
mkdir -p "$INDEX_DIR" "$UNPACKED_DIR"
if ! skopeo copy --src-no-creds "docker://$INDEX_IMAGE" "dir:$INDEX_DIR" >/dev/null; then
  echo "cannot fetch catalog index $INDEX_IMAGE"
  exit 1
fi
INDEX_LAYERS_TEXT=$(jq -er '.layers[].digest | sub("^sha256:"; "")' "$INDEX_DIR/manifest.json") || {
  echo "cannot read catalog index layers"
  exit 1
}
INDEX_LAYERS=()
if [ -n "$INDEX_LAYERS_TEXT" ]; then
  mapfile -t INDEX_LAYERS <<<"$INDEX_LAYERS_TEXT"
fi
for layer in "${INDEX_LAYERS[@]}"; do
  if ! tar -xzf "$INDEX_DIR/$layer" -C "$UNPACKED_DIR"; then
    echo "cannot unpack catalog index layer $layer"
    exit 1
  fi
done

DPDY_FILE=$UNPACKED_DIR/dynamic-plugins.default.yaml
PACKAGES_DIR=$UNPACKED_DIR/extensions/packages
if [ ! -f "$DPDY_FILE" ] || [ ! -d "$PACKAGES_DIR" ]; then
  echo "catalog index is missing dynamic-plugins.default.yaml or extensions/packages"
  exit 1
fi
DPDY_PACKAGES_TEXT=$(yq -r '.plugins[].package' "$DPDY_FILE") || {
  echo "cannot parse catalog index dynamic-plugins.default.yaml"
  exit 1
}
DPDY_PACKAGES=()
if [ -n "$DPDY_PACKAGES_TEXT" ]; then
  mapfile -t DPDY_PACKAGES <<<"$DPDY_PACKAGES_TEXT"
fi
mapfile -t PACKAGE_FILES < <(find "$PACKAGES_DIR" -maxdepth 1 -type f -name '*.yaml' -print | sort)
PACKAGE_ROWS_TEXT=$(yq -r '[.metadata.name // "", .spec.dynamicArtifact // "", .spec.version // ""] | @tsv' "${PACKAGE_FILES[@]}") || {
  echo "cannot parse catalog Package files"
  exit 1
}
mapfile -t PACKAGE_ROWS <<<"$PACKAGE_ROWS_TEXT"

parse_oci_ref() {
  local value=$1
  REF_DOCKER=${value#oci://}
  REF_DOCKER=${REF_DOCKER%%!*}
  REF_SELECTOR=
  if [[ "$value" == *'!'* ]]; then
    REF_SELECTOR=${value##*!}
  fi
  local registry=${REF_DOCKER%%/*}
  local path=${REF_DOCKER#*/}
  local repository=${path%%[@:]*}
  REF_REPOSITORY=$registry/$repository
  REF_DIGEST=
  if [[ "$REF_DOCKER" == *@sha256:* ]]; then
    REF_DIGEST=${REF_DOCKER##*@}
  fi
}

for face_package in "${FACE_PACKAGES[@]}"; do
  [[ "$face_package" == oci://* ]] || continue
  parse_oci_ref "$face_package"
  FACE_REPOSITORY=$REF_REPOSITORY
  FACE_SELECTOR=$REF_SELECTOR
  FACE_DIGEST=$REF_DIGEST

  if [[ "$face_package" == oci://quay.io/veecode/*@sha256:* ]]; then
    repository=${FACE_REPOSITORY#quay.io/veecode/}
    code=$(curl -sS -o /dev/null -w '%{http_code}' "https://quay.io/api/v1/repository/veecode/$repository/manifest/$FACE_DIGEST")
    if [ "$code" = 200 ]; then
      echo "[ok] existing pin quay.io/veecode/$repository@$FACE_DIGEST"
    else
      fail "missing pin quay.io/veecode/$repository@$FACE_DIGEST (HTTP $code)"
    fi
  else
    fail "face OCI ref is not a digest-pinned quay.io/veecode ref: $face_package"
    continue
  fi

  for dpdy_package in "${DPDY_PACKAGES[@]}"; do
    [[ "$dpdy_package" == oci://* ]] || continue
    parse_oci_ref "$dpdy_package"
    if [ "$REF_REPOSITORY" = "$FACE_REPOSITORY" ]; then
      fail "face repository $FACE_REPOSITORY also appears in the catalog index default list"
      break
    fi
  done

  MATCH_REFS=()
  MATCH_VERSIONS=()
  MATCH_SELECTORS=()
  MATCH_NAMES=()
  for package_row in "${PACKAGE_ROWS[@]}"; do
    IFS=$'\t' read -r package_name package_ref package_version <<<"$package_row"
    [[ "$package_ref" == oci://* ]] || continue
    parse_oci_ref "$package_ref"
    PACKAGE_REPOSITORY=$REF_REPOSITORY
    PACKAGE_SELECTOR=$REF_SELECTOR
    PACKAGE_DOCKER_REF=$REF_DOCKER

    [ "$PACKAGE_REPOSITORY" = "$FACE_REPOSITORY" ] || continue
    if [ -n "$FACE_SELECTOR" ] && [ -n "$PACKAGE_SELECTOR" ] && [ "$FACE_SELECTOR" != "$PACKAGE_SELECTOR" ]; then
      continue
    fi

    MATCH_REFS+=("$PACKAGE_DOCKER_REF")
    MATCH_VERSIONS+=("$package_version")
    MATCH_SELECTORS+=("$PACKAGE_SELECTOR")
    MATCH_NAMES+=("$package_name")
  done

  if [ "${#MATCH_REFS[@]}" -eq 0 ]; then
    if [ "$FACE_REPOSITORY" != "quay.io/veecode/veecode-theme" ]; then
      fail "no catalog Package for unlisted face entry $FACE_REPOSITORY"
      continue
    fi

    source_tag=$(awk -v repository="$FACE_REPOSITORY" '
      index($0, repository "@") && match($0, /# was :[^[:space:]]+/) {
        print substr($0, RSTART + 7, RLENGTH - 7)
        exit
      }
    ' "$FACE_PATH")
    if [ -z "$source_tag" ]; then
      fail "cannot read source tag for no-Package face entry $FACE_REPOSITORY"
      continue
    fi

    source_ref="$FACE_REPOSITORY:$source_tag"
    if ! source_digest=$(skopeo inspect --no-creds --format '{{.Digest}}' "docker://$source_ref"); then
      fail "cannot resolve no-Package source tag $source_ref"
      continue
    fi
    if [ "$FACE_DIGEST" != "$source_digest" ]; then
      fail "face digest $FACE_DIGEST does not match no-Package source tag $source_ref digest $source_digest"
      continue
    fi

    NO_PACKAGE_CHECKS=$((NO_PACKAGE_CHECKS + 1))
    echo "[ok] direct digest check $FACE_REPOSITORY@$FACE_DIGEST matches $source_ref"
    continue
  fi
  if [ "${#MATCH_REFS[@]}" -ne 1 ]; then
    fail "expected one catalog Package for $face_package, found ${#MATCH_REFS[@]}"
    continue
  fi

  package_ref=${MATCH_REFS[0]}
  package_name=${MATCH_NAMES[0]}
  package_version=${MATCH_VERSIONS[0]}
  annotation_selector=${FACE_SELECTOR:-${MATCH_SELECTORS[0]}}
  if [ -z "$package_version" ] || [ -z "$annotation_selector" ]; then
    fail "catalog Package $package_name is missing spec.version or an artifact selector"
    continue
  fi

  if ! package_digest=$(skopeo inspect --no-creds --format '{{.Digest}}' "docker://$package_ref"); then
    fail "cannot resolve catalog Package $package_name reference $package_ref"
    continue
  fi
  if [ "$FACE_DIGEST" != "$package_digest" ]; then
    fail "face digest $FACE_DIGEST does not match catalog Package $package_name digest $package_digest"
    continue
  fi

  if ! raw_manifest=$(skopeo inspect --raw --no-creds "docker://$package_ref"); then
    fail "cannot inspect catalog Package $package_name artifact $package_ref"
    continue
  fi
  if ! annotation=$(jq -er '.annotations["io.backstage.dynamic-packages"]' <<<"$raw_manifest"); then
    fail "catalog Package $package_name artifact has no dynamic-packages annotation"
    continue
  fi
  if ! annotation_json=$(base64 -d <<<"$annotation"); then
    fail "cannot decode catalog Package $package_name artifact annotation"
    continue
  fi
  if ! annotation_version=$(jq -er --arg selector "$annotation_selector" '[.[] | .[$selector].version? | select(. != null)] | if length == 1 then .[0] else error("expected one selector version") end' <<<"$annotation_json"); then
    fail "catalog Package $package_name artifact has no unique version for selector $annotation_selector"
    continue
  fi
  if [ "$package_version" != "$annotation_version" ]; then
    fail "catalog Package $package_name spec.version $package_version does not match artifact annotation $annotation_version"
    continue
  fi

  PACKAGE_CHECKS=$((PACKAGE_CHECKS + 1))
  echo "[ok] check 2 $package_name digest=$package_digest version=$package_version selector=$annotation_selector"
done

[ "$PACKAGE_CHECKS" -gt 0 ] || fail "no face Package references were checked against the catalog index"
if [ "$FAILURES" -eq 0 ]; then
  echo "All face pins resolve; $PACKAGE_CHECKS catalog Package refs match their digests and artifact versions; $NO_PACKAGE_CHECKS no-Package face digests match their source tags."
  exit 0
fi
echo "$FAILURES face pin check(s) failed."
exit 1
