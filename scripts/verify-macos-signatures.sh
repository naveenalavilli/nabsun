#!/usr/bin/env bash
set -euo pipefail
app_path=${1:?Pass the path to Nabsun.app}
: "${APPLE_TEAM_ID:?Expected Apple team ID is required}"
: "${MAC_SIGNING_IDENTITY:?Expected Developer ID identity is required}"
[[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo 'Invalid team ID' >&2; exit 1; }
[[ -d "$app_path" && -f "$app_path/Contents/MacOS/Nabsun" ]] || { echo 'Missing Nabsun app bundle' >&2; exit 1; }

verify_identity() {
  local file_path=$1 details
  codesign --verify --strict --verbose=2 "$file_path"
  details=$(codesign -d --verbose=4 "$file_path" 2>&1)
  printf '%s\n' "$details" | grep -Fx "TeamIdentifier=$APPLE_TEAM_ID" >/dev/null
  printf '%s\n' "$details" | grep -Fx "Authority=$MAC_SIGNING_IDENTITY" >/dev/null
  printf '%s\n' "$details" | grep -E '^CodeDirectory .*flags=.*runtime' >/dev/null
}
codesign --verify --deep --strict --verbose=2 "$app_path"
verify_identity "$app_path"
# Verify native inference code explicitly, including libraries outside Frameworks.
engine_dir="$app_path/Contents/Resources/vendor/llama"
[[ -d "$engine_dir" ]] || { echo 'Bundled inference engine missing' >&2; exit 1; }
while IFS= read -r -d '' binary; do
  if file -b "$binary" | grep -q 'Mach-O'; then verify_identity "$binary"; fi
done < <(find "$engine_dir" -type f -print0)
xcrun stapler validate "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"
echo 'Verified Developer ID, team, hardened runtime and notarization ticket.'
