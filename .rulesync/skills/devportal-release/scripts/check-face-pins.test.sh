#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GATE=$SCRIPT_DIR/check-face-pins.sh
FIXTURE_ROOT=$(mktemp -d)
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

mkdir -p "$FIXTURE_ROOT/bin" "$FIXTURE_ROOT/index/extensions/packages" "$FIXTURE_ROOT/image"
cat > "$FIXTURE_ROOT/bin/skopeo" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  copy)
    destination=${@: -1}
    destination=${destination#dir:}
    mkdir -p "$destination"
    cp "$FIXTURE_ROOT/manifest.json" "$destination/manifest.json"
    cp "$FIXTURE_ROOT/layer" "$destination/fixture-layer"
    ;;
  inspect)
    if [[ " $* " == *" --format "* ]]; then
      cat "$FIXTURE_ROOT/resolved-digest"
    elif [[ " $* " == *" --raw "* ]]; then
      cat "$FIXTURE_ROOT/raw-manifest.json"
    else
      exit 2
    fi
    ;;
  *) exit 2 ;;
esac
MOCK
cat > "$FIXTURE_ROOT/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '200'
MOCK
chmod +x "$FIXTURE_ROOT/bin/skopeo" "$FIXTURE_ROOT/bin/curl"

GOOD_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
WRONG_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s' "$GOOD_DIGEST" > "$FIXTURE_ROOT/resolved-digest"
annotation=$(printf '%s' '[{"test-plugin":{"name":"@test/plugin-dynamic","version":"1.0.0"}}]' | base64 -w0)
printf '{"schemaVersion":2,"annotations":{"io.backstage.dynamic-packages":"%s"}}\n' "$annotation" > "$FIXTURE_ROOT/raw-manifest.json"
cat > "$FIXTURE_ROOT/index/extensions/packages/test-plugin.yaml" <<'PACKAGE'
apiVersion: backstage.io/v1alpha1
kind: Package
metadata:
  name: test-plugin
spec:
  dynamicArtifact: oci://quay.io/veecode/test-plugin:bs_1.52.0__1.0.0!test-plugin
  version: 1.0.0
PACKAGE
cat > "$FIXTURE_ROOT/index/dynamic-plugins.default.yaml" <<'DPDY'
plugins: []
DPDY
tar -czf "$FIXTURE_ROOT/layer" -C "$FIXTURE_ROOT/index" .
printf '{"schemaVersion":2,"layers":[{"digest":"sha256:fixture-layer"}]}\n' > "$FIXTURE_ROOT/manifest.json"
write_face() {
  local first_ref=$1
  {
    printf 'plugins:\n'
    printf '  - package: %s\n' "$first_ref"
    printf '    disabled: false\n'
    for n in $(seq 1 19); do
      printf '  - package: "@test/plugin-%s@1.0.0"\n' "$n"
      printf '    disabled: false\n'
    done
  } > "$FIXTURE_ROOT/face.yaml"
}
run_gate() {
  env PATH="$FIXTURE_ROOT/bin:$PATH" \
    FIXTURE_ROOT="$FIXTURE_ROOT" \
    FACE_FILE="$FIXTURE_ROOT/face.yaml" \
    CATALOG_INDEX_IMAGE=quay.io/veecode/plugin-catalog-index:test \
    "$GATE" fixture > "$FIXTURE_ROOT/output.txt" 2>&1
}
expect_failure() {
  local description=$1
  if run_gate; then
    echo "FAIL: gate unexpectedly passed: $description"
    cat "$FIXTURE_ROOT/output.txt"
    exit 1
  fi
}

write_face "oci://quay.io/veecode/test-plugin@$GOOD_DIGEST!test-plugin"
if ! run_gate; then
  cat "$FIXTURE_ROOT/output.txt"
  echo "FAIL: valid face failed"
  exit 1
fi
grep -q 'face: 20 entries' "$FIXTURE_ROOT/output.txt"
grep -q 'All face pins resolve; 1 catalog Package refs match' "$FIXTURE_ROOT/output.txt"
echo "PASS: 20-entry face, existing pin check, digest match, and annotation version match"

cat > "$FIXTURE_ROOT/index/dynamic-plugins.default.yaml" <<'DPDY'
plugins:
  - package: oci://quay.io/veecode/test-plugin:bs_1.52.0__1.0.0!test-plugin
    disabled: true
DPDY
expect_failure 'face repository appears in default list'
grep -q 'also appears in the catalog index default list' "$FIXTURE_ROOT/output.txt"
echo "PASS: check 1 rejects a face repository in the default list"

cat > "$FIXTURE_ROOT/index/dynamic-plugins.default.yaml" <<'DPDY'
plugins: []
DPDY
write_face "oci://quay.io/veecode/test-plugin@$WRONG_DIGEST!test-plugin"
expect_failure 'face digest differs from Package tag'
grep -q 'does not match catalog Package' "$FIXTURE_ROOT/output.txt"
echo "PASS: check 2 rejects a wrong digest"

write_face "oci://quay.io/veecode/test-plugin@$GOOD_DIGEST!test-plugin"
sed -i 's/version: 1.0.0/version: 2.0.0/' "$FIXTURE_ROOT/index/extensions/packages/test-plugin.yaml"
expect_failure 'Package version differs from annotation'
grep -q 'does not match artifact annotation' "$FIXTURE_ROOT/output.txt"
echo "PASS: check 2 rejects a Package version that differs from the artifact annotation"
