#!/usr/bin/env bash
# Kill every Cinevox dev process and free the dev ports — then VERIFY.
#
# Usage:  npm run stop          (or: bash scripts/stop-dev.sh)
#
# What it kills:
#   1. LISTEN-sockets on :4000 :5173 :5174 (the actual port owners)
#   2. node/tsx/npm/vite/esbuild processes referencing this project
#      (tsx watch parents, orphaned server children, npm wrappers)
#   3. stray test-chromium instances and yt-dlp jobs
#
# What it never touches: terminals, browsers, or anything else — every
# pattern is anchored to node binaries / project paths / exact commands.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
PROJECT_DIR=$(pwd -P)

self=$$
parent=$PPID
killed=()

kill_pid() { # pid, reason
  local pid=$1 why=$2
  [ -n "$pid" ] || return
  [ "$pid" = "$self" ] && return
  [ "$pid" = "$parent" ] && return
  if kill -9 "$pid" 2>/dev/null; then
    killed+=("pid $pid ($why)")
  fi
}

# 1) Free the ports: only true LISTEN sockets (a vite proxy connection to
#    :4000 is a client socket and must NOT be treated as the server).
for port in 4000 5173 5174; do
  while read -r pid; do
    kill_pid "$pid" "listener :$port"
  done < <(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null)
done

# 2) Everything running out of this project (node binaries only).
while read -r pid; do
  kill_pid "$pid" "project node"
done < <(pgrep -f "node .*${PROJECT_DIR}" 2>/dev/null)

while read -r pid; do
  kill_pid "$pid" "project esbuild"
done < <(pgrep -f "${PROJECT_DIR}/node_modules/.*esbuild" 2>/dev/null)

# npm / concurrently wrappers (exact command strings — safe by construction)
for pat in "npm run dev -w server" "npm run dev -w client" "concurrently -n server,client"; do
  while read -r pid; do
    kill_pid "$pid" "wrapper"
  done < <(pgrep -f "$pat" 2>/dev/null)
done

# 3) Test leftovers
while read -r pid; do
  kill_pid "$pid" "cdp chromium"
done < <(pgrep -f "user-data-dir=/tmp/opencode/cdp" 2>/dev/null)

while read -r pid; do
  kill_pid "$pid" "yt-dlp"
done < <(pgrep -f "^yt-dlp " 2>/dev/null)

if [ ${#killed[@]} -gt 0 ]; then
  printf 'killed: %s\n' "${killed[@]}"
else
  echo "killed: nothing was running"
fi
sleep 0.5

# ---- verification: fail loudly if anything survived ----
fail=0
for port in 4000 5173 5174; do
  leftover=$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')
  if [ -n "$leftover" ]; then
    echo "STILL LISTENING on :$port -> pids: $leftover"
    fail=1
  fi
done
for pat in "node .*${PROJECT_DIR}" "${PROJECT_DIR}/node_modules/.*esbuild" "npm run dev -w server" "npm run dev -w client" "concurrently -n server,client" "user-data-dir=/tmp/opencode/cdp"; do
  if pgrep -f "$pat" > /dev/null 2>&1; then
    # our own shell can match the pattern strings it contains — skip pids
    # whose cmdline is this very script
    for pid in $(pgrep -f "$pat"); do
      [ "$pid" = "$self" ] || [ "$pid" = "$parent" ] && continue
      if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "stop-dev.sh"; then
        continue
      fi
      echo "SURVIVOR pid $pid: $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
      fail=1
    done
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "stop-dev: FAILED — leftovers remain (see above)"
  exit 1
fi
echo "stop-dev: ports free, no project processes left"
exit 0
