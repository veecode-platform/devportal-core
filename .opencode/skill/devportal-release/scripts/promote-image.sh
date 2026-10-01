#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s <image-repository> <candidate-tag> <final-tag>\n' "${0##*/}" >&2
  printf 'The final-tag check and copy are not atomic; enable registry-side tag immutability to guard this race.\n' >&2
  printf 'Log in to the registry with push rights before running this command.\n' >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  usage
  exit 2
fi

repository=$1
candidate_tag=$2
final_tag=$3
SKOPEO=${SKOPEO:-skopeo}
SKOPEO_TLS_VERIFY=${SKOPEO_TLS_VERIFY:-true}

[[ $repository == */* && $repository != *//* && $repository != */ && $repository != *@* ]] || fail "image repository must include a registry and path"
[[ ${repository##*/} != *:* ]] || fail "image repository must not include a tag"
[[ $candidate_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "invalid candidate tag: $candidate_tag"
[[ $final_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "invalid final tag: $final_tag"
[[ $SKOPEO_TLS_VERIFY == true || $SKOPEO_TLS_VERIFY == false ]] || fail "SKOPEO_TLS_VERIFY must be true or false"
command -v "$SKOPEO" > /dev/null || fail "skopeo command not found: $SKOPEO"
command -v jq > /dev/null || fail "jq command not found"

candidate_ref="$repository:$candidate_tag"
final_ref="$repository:$final_tag"
candidate_transport="docker://$candidate_ref"
final_transport="docker://$final_ref"

candidate_digest=$("$SKOPEO" inspect --tls-verify="$SKOPEO_TLS_VERIFY" --format '{{.Digest}}' "$candidate_transport") || fail "cannot inspect candidate $candidate_ref"
[[ $candidate_digest =~ ^sha256:[a-f0-9]{64}$ ]] || fail "candidate returned an invalid manifest digest: $candidate_digest"

candidate_digest_transport="docker://$repository@$candidate_digest"
candidate_manifest=$("$SKOPEO" inspect --tls-verify="$SKOPEO_TLS_VERIFY" --raw "$candidate_digest_transport") || fail "cannot read candidate manifest $candidate_digest"
jq -e '
  (.mediaType == "application/vnd.oci.image.index.v1+json" or
   .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json") and
  (.manifests | type == "array" and length > 0)
' <<< "$candidate_manifest" > /dev/null || fail "candidate $candidate_ref is not a multi-architecture manifest list"

error_file=$(mktemp)
trap 'rm -f "$error_file"' EXIT
if "$SKOPEO" inspect --tls-verify="$SKOPEO_TLS_VERIFY" --raw "$final_transport" > /dev/null 2> "$error_file"; then
  fail "final tag already exists: $final_ref"
fi
if ! grep -Eqi 'manifest unknown|name unknown|StatusCode: 404|status code: 404' "$error_file"; then
  cat "$error_file" >&2
  fail "cannot confirm that final tag is absent: $final_ref"
fi

"$SKOPEO" copy --all --preserve-digests \
  --src-tls-verify="$SKOPEO_TLS_VERIFY" \
  --dest-tls-verify="$SKOPEO_TLS_VERIFY" \
  "$candidate_digest_transport" \
  "$final_transport"

final_digest=$("$SKOPEO" inspect --tls-verify="$SKOPEO_TLS_VERIFY" --format '{{.Digest}}' "$final_transport") || fail "cannot inspect promoted tag $final_ref"
printf 'candidate_digest=%s\nfinal_digest=%s\n' "$candidate_digest" "$final_digest"
[[ $final_digest == "$candidate_digest" ]] || fail "promoted digest differs from candidate digest"
