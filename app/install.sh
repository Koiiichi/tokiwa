#!/usr/bin/env bash
# Install the Tokiwa app that `tokiwa` opens by default, from a committed version of this folder.
#
#   bash install.sh [REVISION]   install REVISION (default HEAD) into ~/.local/lib/tokiwa/opentui
#   bash install.sh --rollback   restore the copy that the last install replaced
#
# The copy gets its own dependencies at the versions in package-lock.json (npm ci). The install stops and leaves the
# current copy in place if Bun does not start or the app does not load.
set -euo pipefail

APP=${TOKIWA_APP_DIR:-$HOME/.local/lib/tokiwa/opentui}
NEW=$APP.new
OLD=$APP.previous

die() { printf 'install: %s\n' "$*" >&2; exit 1; }

if [[ ${1:-} == --rollback ]]; then
  [[ -d $OLD ]] || die 'There is no previous copy to restore.'
  rm -rf "$NEW"
  [[ -d $APP ]] && mv "$APP" "$NEW"
  mv "$OLD" "$APP"
  [[ -d $NEW ]] && mv "$NEW" "$OLD"
  printf 'Restored %s\n' "$(head -1 "$APP/INSTALLED" 2>/dev/null || echo 'the previous copy')"
  exit 0
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
prefix=$(git -C "$here" rev-parse --show-prefix)
commit=$(git -C "$repo" rev-parse --verify "${1:-HEAD}^{commit}")
# The copy holds this folder and a start script:  opentui/app/  opentui/run
parent=${prefix%/}
slashes=${parent//[^\/]/}
rm -rf "$NEW"
mkdir -p "$NEW"
git -C "$repo" archive "$commit" "$prefix" | tar -x -C "$NEW" --strip-components="${#slashes}"
UI=$NEW/${parent##*/}
[[ -x $UI/run && -f $UI/package-lock.json && -f $UI/app.ts ]] \
  || { rm -rf "$NEW"; die "Revision ${commit:0:12} has no runnable interface."; }
# Dependencies come only from npm ci. A committed node_modules (for example a link to another
# worktree) is removed first: rm removes a link itself, never the folder that it names.
rm -rf "$UI/node_modules"
printf '%s\n' '#!/bin/sh' "exec \"\$(dirname \"\$0\")/${parent##*/}/run\" \"\$@\"" > "$NEW/run"
chmod 755 "$NEW/run"
(cd "$UI" && npm ci --omit=dev --no-fund --no-audit) || { rm -rf "$NEW"; die 'npm ci failed.'; }

# The start check loads the app, its native OpenTUI library and the MCP server without opening a screen.
if ! (cd "$UI" && ./node_modules/bun/bin/bun.exe -e 'await import("./app.ts"); await import("./mcp.ts")') >/dev/null; then
  rm -rf "$NEW"
  die 'The new copy did not pass its start check. The installed copy is unchanged.'
fi
printf 'commit %s\ninstalled %s\n' "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$NEW/INSTALLED"

rm -rf "$OLD"
[[ -d $APP ]] && mv "$APP" "$OLD"
mv "$NEW" "$APP"
printf 'Installed commit %s at %s. Run tokiwa to open it.\n' "${commit:0:12}" "$APP"
