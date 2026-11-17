#!/usr/bin/env bash
# Submodule Engine Build Scan
# ===========================
# Proves the H9 patch set still rebuilds the engine from the PRISTINE xash3d-fwgs
# submodule: it applies every patch xash.bat's :engine applies, in order, to the
# submodule (and its 3 patched nested submodules), and fails on any reject. It does
# NOT compile the engine -- just the patch apply -- so it runs in a couple of minutes.
#
# The patch list is read straight from xash3d-h9-patches/xash.bat, so adding a patch
# (its one `call :patch` line) never needs editing this script or the workflow.
#
# Usage:  tools/submodule-engine-build-scan.sh [REPO_ROOT]   (defaults to this repo)
set -u
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
FWGS="$REPO/xash3d-fwgs"
XASHP="$REPO/xash3d-h9-patches/patches"
WEB="$REPO/webassembly-patch"
XASHBAT="$REPO/xash3d-h9-patches/xash.bat"

for p in "$FWGS/wscript" "$XASHBAT"; do
  [ -e "$p" ] || { echo "missing: $p (is the xash3d-fwgs submodule initialized?)"; exit 2; }
done

# Check the engine (and its 3 patched nested submodules) out in LF so the LF patches
# apply via plain `git apply`. On a CRLF checkout they fall to xash.bat's --3way
# fallback instead; both are proven, LF is the clean path and matches a Linux checkout.
git -C "$FWGS" -c core.autocrlf=false -c core.eol=lf checkout -- . 2>/dev/null || true
for s in mainui freevgui library_suffix; do
  d="$FWGS/3rdparty/$s"
  [ -e "$d/.git" ] && git -C "$d" -c core.autocrlf=false -c core.eol=lf checkout -- . 2>/dev/null || true
done

rej=0; ok=0; three=0; n=0
while IFS= read -r line; do
  t=$(printf '%s' "$line" | sed -E 's/^[^"]*"([^"]*)".*/\1/')
  p=$(printf '%s' "$line" | sed -E 's/^[^"]*"[^"]*"[[:space:]]*"([^"]*)".*/\1/')
  tgt=$(printf '%s' "$t" | sed 's#\\#/#g' | sed "s#%FWGS%#$FWGS#g")
  pp=$(printf '%s' "$p" | sed 's#\\#/#g' | sed "s#%XASH%/patches#$XASHP#g; s#%WEB%#$WEB#g")
  n=$((n+1))
  if [ ! -f "$pp" ]; then echo "MISSING PATCH: $pp"; rej=$((rej+1)); continue; fi
  if [ ! -d "$tgt" ]; then echo "MISSING TARGET: $tgt (submodule not initialized?)"; rej=$((rej+1)); continue; fi
  if   git -C "$tgt" apply --whitespace=nowarn "$pp" 2>/dev/null; then ok=$((ok+1));
  elif git -C "$tgt" apply --3way --whitespace=nowarn "$pp" 2>/dev/null; then three=$((three+1)); ok=$((ok+1));
  else echo "REJECT: $(basename "$pp")  ->  ${tgt#$REPO/}"; rej=$((rej+1)); fi
done < <(grep -E '^[[:space:]]*call :patch ' "$XASHBAT")

echo "----"
echo "patches=$n  applied=$ok (plain=$((ok-three)) 3way=$three)  rejects=$rej"
if [ "$rej" -eq 0 ]; then echo "SUBMODULE ENGINE BUILD SCAN: PASS"; exit 0; else echo "SUBMODULE ENGINE BUILD SCAN: FAIL"; exit 1; fi
