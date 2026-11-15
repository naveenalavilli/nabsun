#!/usr/bin/env bash
set -euo pipefail
app_path=${1:?Pass the signed Nabsun.app path}
: "${RUNNER_TEMP:?Run this smoke check on a disposable CI runner}"
profile=$(mktemp -d "$RUNNER_TEMP/nabsun-signed-profile.XXXXXX")
log_path="$RUNNER_TEMP/nabsun-signed-smoke.log"
env -u ELECTRON_RUN_AS_NODE "$app_path/Contents/MacOS/Nabsun" --user-data-dir="$profile" >"$log_path" 2>&1 &
app_pid=$!
cleanup() { kill "$app_pid" 2>/dev/null || true; }
trap cleanup EXIT
started=false
for ((attempt=0; attempt<30; attempt++)); do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    cat "$log_path" >&2
    echo 'Signed application exited during startup' >&2
    exit 1
  fi
  if grep -F '[bridge] listening on' "$log_path" >/dev/null && pgrep -P "$app_pid" -f 'Nabsun Helper' >/dev/null; then
    started=true
    break
  fi
  sleep 1
done
if [[ "$started" != true ]]; then cat "$log_path" >&2; echo 'Signed app did not finish startup' >&2; exit 1; fi
sleep 5
kill -0 "$app_pid"
if grep -E 'A JavaScript error occurred in the main process|FATAL ERROR|Code Signature Invalid|Trace/BPT trap' "$log_path"; then
  echo 'Signed application reported a fatal startup error' >&2
  exit 1
fi
echo 'Signed application and helper processes started using an isolated CI profile.'
