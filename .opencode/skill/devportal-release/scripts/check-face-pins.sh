#!/usr/bin/env bash
# Check that every OCI plugin the product face pins by digest still exists on quay.
#
#   check-face-pins.sh [devportal-core ref]     (default: main)
#
# The image bakes veecode/dynamic-plugins.veecode.yaml. A pin whose manifest quay
# has garbage-collected makes the installer abort and the pod never leaves init,
# so run this before building an image. Read-only; exits 1 on any missing pin.
set -uo pipefail

REF=${1:-main}
face=$(gh api "repos/veecode-platform/devportal-core/contents/veecode/dynamic-plugins.veecode.yaml?ref=$REF" --jq .content | base64 -d)
[ -n "$face" ] || { echo "cannot read the face at devportal-core@$REF"; exit 1; }

entries=$(grep -c '^- package:' <<<"$face")
echo "devportal-core@$REF face: $entries entries (the Containerfile gate requires 20)"
[ "$entries" -eq 20 ] || echo "[fail] entry count is $entries, not 20"

missing=0
while read -r repo digest; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://quay.io/api/v1/repository/veecode/$repo/manifest/$digest")
  if [ "$code" = 200 ]; then
    echo "[ok] quay.io/veecode/$repo@${digest:0:19}"
  else
    echo "[missing] quay.io/veecode/$repo@$digest (HTTP $code)"
    missing=$((missing + 1))
  fi
done < <(grep -oE 'oci://quay\.io/veecode/[^@ ]+@sha256:[0-9a-f]{64}' <<<"$face" \
  | sed -E 's#oci://quay\.io/veecode/([^@]+)@(sha256:[0-9a-f]{64})#\1 \2#' | sort -u)

[ "$entries" -eq 20 ] && [ "$missing" -eq 0 ] && echo "All face pins resolve." && exit 0
exit 1
