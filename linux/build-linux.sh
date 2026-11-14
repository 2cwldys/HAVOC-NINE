#!/usr/bin/env bash
# ===========================================================================
#  linux/build-linux.sh -- builds H9's Linux i386 server in one run and lays
#                          it out as H9XASH-linux\, the folder stage-h9xash.ps1
#                          packs into dist\H9XASH-linux-server.zip
#
#  Runs on x86-64 Debian or Ubuntu (glibc 2.34 or newer on the build machine
#  is what the binaries then ask for; build-linux.ps1 runs it in the WSL2
#  distro h9build). The 32-bit toolchain is what linux/h9build-setup.sh installs.
#
#      build-linux.sh                    every step below, in this order
#      build-linux.sh rets engine        only these steps
#
#  Steps
#      rets      reTS's game library (H9's reTS source), hl.so, installed as ts/dlls/ts_i386.so
#      metamod   Metamod-R (the H9 slot patch is in the source), metamod_i386.so
#      engine    Xash3D FWGS built -d (dedicated) from the patched tree: xashds + filesystem_stdio.so
#      amxx      AMX Mod X with reTSX (goldsrc-net's 64bit branch and H9's changes), through AMBuild
#      rcbot     RCBot 1.51b13 with H9's ten patches (rcbot-patch\src over rcbot-upstream)
#      assemble  lays the files out like H9XASH, writes ts/gameinfo.txt, liblist.gam and
#                addons/metamod/plugins.ini for Linux, a .patch note beside every .so, BUILDINFO.txt;
#                with AMX Mod X it also installs the easy_http module (see below)
#
#  Environment
#      H9_SRC    the TSM tree (default /mnt/d/Downloads/TSM)
#      H9_OUT    the folder assemble writes (default $H9_SRC/H9XASH-linux); only a folder this script
#                wrote (it holds BUILDINFO.txt) or an empty one is replaced
#      H9_WORK   build folders on the distro's own disk (default $HOME/work)
#      H9_JOBS   parallel jobs (default 4: one heavy job at a time on the PC)
#      H9_SKIP   steps to leave out of the default run, e.g. H9_SKIP=amxx
#      H9_EASYHTTP_ZIP  a copy of the AmxxEasyHttp release zip (EASYHTTP_URL below), for a machine that cannot
#                download it; default $H9_WORK/dl/release_linux_v<version>.zip, fetched there when it is missing
#
#  The easy_http module is not built here: ts_advertise, h9_presence, h9_community, h9_compete and h9_rank need it
#  (their #include <easy_http>), and the Next21 Team releases it for Linux i386. assemble downloads release 1.4.0
#  (the version of the Windows easy_http_amxx.dll), checks the SHA-256 of the zip and of the module against the
#  values pinned below, and installs easy_http_amxx_i386.so, its CA bundle and the license (LICENSE-AMXXEASYHTTP.txt).
#
#  AMX Mod X needs AMBuild (github.com/alliedmodders/ambuild), the official AMX Mod X build tool:
#  pip3 install git+https://github.com/alliedmodders/ambuild   (h9build-setup.sh --with-ambuild does it).
#  Without it the amxx step stops with that message; H9_SKIP=amxx builds the rest.
#
#  Source of truth: TSM/linux/build-linux.sh -- edit it there.
# ===========================================================================
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

SRC=${H9_SRC:-/mnt/d/Downloads/TSM}
OUT=${H9_OUT:-$SRC/H9XASH-linux}
WORK=${H9_WORK:-$HOME/work}
JOBS=${H9_JOBS:-4}
SKIP=" ${H9_SKIP:-} "
ALL="rets metamod engine amxx rcbot assemble"

# AmxxEasyHttp, MIT (linux/LICENSE-AMXXEASYHTTP.txt): the release step_assemble installs, and the hashes it must have
EASYHTTP_VERSION=1.4.0
EASYHTTP_URL="https://github.com/Next21Team/AmxxEasyHttp/releases/download/$EASYHTTP_VERSION/release_linux_v$EASYHTTP_VERSION.zip"
EASYHTTP_ZIP_SHA256=5d265398590f033900602c7e6e722d5232170f2ed2e48315f6af052e9de9082b
EASYHTTP_SO_SHA256=137140a4a33cc22371f283ba0907a0a8ddcd1c0bd6ce5202dc98f7472f8ff457

say() { printf '\n==== %s\n' "$*"; }
die() { printf 'build-linux: %s\n' "$*" >&2; exit 1; }

preflight() {
	local t
	for t in gcc g++ make rsync python3 file objdump sha256sum; do
		command -v "$t" >/dev/null || die "$t is missing; run linux/h9build-setup.sh as root first"
	done
	echo 'int main(void){return 0;}' > "$WORK/.t.c"
	gcc -m32 "$WORK/.t.c" -o "$WORK/.t32" 2>/dev/null || die "gcc -m32 does not link: install gcc-multilib (linux/h9build-setup.sh)"
	rm -f "$WORK/.t.c" "$WORK/.t32"
}

need_cmake() {
	command -v cmake >/dev/null || die "cmake is missing (linux/h9build-setup.sh)"
	local v; v=$(cmake --version | head -1 | sed 's/[^0-9.]//g')
	[ "$(printf '%s\n3.23\n' "$v" | sort -V | head -1)" = 3.23 ] || die "cmake $v is older than 3.23, which reTS needs (pip3 install cmake)"
}

sync_tree() { # <from> <to> [rsync excludes...]
	local from=$1 to=$2; shift 2
	mkdir -p "$to"
	rsync -a --delete "$@" "$from/" "$to/"
}

step_rets() {
	say "rets: reTS game library, Linux i386"
	need_cmake
	command -v ninja >/dev/null || die "ninja is missing (linux/h9build-setup.sh)"
	sync_tree "$SRC/reTS" "$WORK/reTS" --exclude 'build-*' --exclude release_binaries --exclude .git --exclude binaries
	rm -rf "$WORK/reTS/build-i386"; mkdir -p "$WORK/reTS/build-i386"
	( cd "$WORK/reTS/build-i386"
	  cmake -S .. -B . -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=../cmake/LinuxToolchain.cmake > cmake.log 2>&1 || { tail -30 cmake.log; exit 1; }
	  nice -n 10 cmake --build . -j"$JOBS" --target hl 2>&1 | tail -3 )
	[ -f "$WORK/reTS/build-i386/dlls/hl.so" ] || die "reTS built no hl.so"
}

step_metamod() {
	say "metamod: Metamod-R, Linux i386"
	need_cmake
	sync_tree "$SRC/metamod-r" "$WORK/metamod-r" --exclude .git --exclude build
	( cd "$WORK/metamod-r"
	  chmod +x metamod/version/appversion.sh; sed -i 's/\r$//' metamod/version/appversion.sh
	  rm -rf build; mkdir build; cd build
	  CC=gcc CXX=g++ cmake -S ../metamod -B . -DCMAKE_BUILD_TYPE=Release > cmake.log 2>&1 || { tail -30 cmake.log; exit 1; }
	  nice -n 10 make -j"$JOBS" 2>&1 | tail -3 )
	[ -f "$WORK/metamod-r/build/metamod_i386.so" ] || die "Metamod-R built no metamod_i386.so"
}

step_engine() {
	say "engine: Xash3D FWGS dedicated server, Linux i386, from the patched tree"
	# The tree in $SRC/xash3d-fwgs already holds the patch chain (xash.bat applies it there).
	sync_tree "$SRC/xash3d-fwgs" "$WORK/xash3d-fwgs" --exclude .git --exclude build --exclude '.lock-waf*' --exclude .builds --exclude .github
	( cd "$WORK/xash3d-fwgs"
	  rm -rf build .lock-waf*
	  chmod +x waf
	  python3 waf configure -T release -d -4 > configure.log 2>&1 || { tail -30 configure.log; exit 1; }
	  nice -n 10 python3 waf build -j"$JOBS" 2>&1 | tail -3 )
	[ -f "$WORK/xash3d-fwgs/build/engine/xash" ] || die "the engine build made no xash"
	[ -f "$WORK/xash3d-fwgs/build/filesystem/filesystem_stdio.so" ] || die "the engine build made no filesystem_stdio.so"
}

step_amxx() {
	say "amxx: AMX Mod X with reTSX, Linux i386"
	command -v ambuild >/dev/null && python3 -c 'import ambuild2' 2>/dev/null || die "AMBuild is not installed: pip3 install git+https://github.com/alliedmodders/ambuild (or linux/h9build-setup.sh --with-ambuild); H9_SKIP=amxx builds the rest"
	command -v nasm >/dev/null || die "nasm is missing (linux/h9build-setup.sh)"
	sync_tree "$SRC/AMXMODX" "$WORK/amxmodx" --exclude .git --exclude 'obj-*' --exclude build --exclude 'msvc*'
	# AMX Mod X's build script wants a folder with metamod/ in it holding meta_api.h and the rest;
	# Metamod-R keeps those headers in metamod/src
	rm -rf "$WORK/mm-shim"; mkdir -p "$WORK/mm-shim/metamod"
	cp -r "$SRC/metamod-r/metamod/src/." "$WORK/mm-shim/metamod/"
	# the HL SDK headers (common, dlls, engine, game_shared, pm_shared, public): Metamod-R carries a clean set whose engine
	# function types match the tables in the module sources; reTS's own dlls/ headers do not
	mkdir -p "$WORK/mm-shim/hlsdk"
	cp -r "$SRC/metamod-r/metamod/include/." "$WORK/mm-shim/hlsdk/"
	# its globalvars_t names two members deathmatch_ and coop_; the module sources (fakemeta) use the SDK's deathmatch and coop
	sed -i 's/\bdeathmatch_;/deathmatch;/; s/\bcoop_;/coop;/' "$WORK/mm-shim/hlsdk/engine/progdefs.h"
	# and a cvar_callback_t / cvar_listener_t that AMX Mod X's own engine_strucs.h defines again
	sed -i '/^using cvar_callback_t/,/^};/d' "$WORK/mm-shim/hlsdk/common/cvardef.h"
	# and the hash_types_e enum that fakemeta's own headers define
	sed -i '/^enum hash_types_e/d' "$WORK/mm-shim/hlsdk/dlls/extdef.h"
	# the modules (written for the older Metamod) declare Meta_Query with a const interface string
	sed -i 's/int Meta_Query(char \*interfaceVersion/int Meta_Query(const char *interfaceVersion/' "$WORK/mm-shim/metamod/meta_api.h"
	# the modules size their message tables with MAX_REG_MSGS, which the older Metamod's meta_api.h brought in
	# (Metamod-R keeps it in mreg.h, which needs <vector>; the one constant is all they use)
	# and the Windows BOOL type the module sources use (a typedef again to the same type is fine in C++)
	printf '\nenum { MAX_REG_MSGS = 256 };\ntypedef int BOOL;\n#ifndef TRUE\n#define TRUE 1\n#endif\n#ifndef FALSE\n#define FALSE 0\n#endif\nclass CBaseEntity;\nclass CBasePlayer;\n#ifndef AMXAPI\n#define AMXAPI\n#endif\n#ifndef MAX_WEAPONS\n#define MAX_WEAPONS 32\n#endif\ntypedef void *DLHANDLE;\nstruct model_s;\ntypedef struct model_s model_t;\n#ifndef FIND_ENTITY_BY_TARGET\n#define FIND_ENTITY_BY_TARGET(e, n) ((*g_engfuncs.pfnFindEntityByString)((e), "target", (n)))\n#endif\n#ifndef LOCALINFO\n#define LOCALINFO(k) ((*g_engfuncs.pfnInfoKeyValue)((*g_engfuncs.pfnGetInfoKeyBuffer)(NULL), (k)))\n#define SET_LOCALINFO(k, v) ((*g_engfuncs.pfnSetKeyValue)((*g_engfuncs.pfnGetInfoKeyBuffer)(NULL), (k), (v)))\n#define ENTITY_KEYVALUE(e, k) ((*g_engfuncs.pfnInfoKeyValue)((*g_engfuncs.pfnGetInfoKeyBuffer)((e)), (k)))\n#define ENTITY_SET_KEYVALUE(e, k, v) ((*g_engfuncs.pfnSetKeyValue)((*g_engfuncs.pfnGetInfoKeyBuffer)((e)), (k), (v)))\n#endif\n' >> "$WORK/mm-shim/metamod/meta_api.h"
	# AMX Mod X's own engine_strucs.h repeats a server type the SDK set defines in a header the modules include too:
	# leave it out of the copy that is built
	python3 "$SRC/linux/dedupe-engine-types.py" "$WORK/amxmodx/public/engine_strucs.h" sv_delta_t
	( cd "$WORK/amxmodx"
	  find . -name '*.sh' -exec sed -i 's/\r$//' {} \;
	  # H9 runs The Specialists: the modules of the other games (Counter-Strike, Day of Defeat, Natural
	  # Selection, Team Fortress Classic) are left out of the build, in this copy only
	  sed -i "/^  'modules\/\(cstrike\|dod\|ns\|tfcx\)\/.*',\r\?\$/d" AMBuildScript
	  # the SDK's Visual C++ pragmas are unknown to gcc and C++17 is what the engine-side headers expect: build as gnu++17
	  # without -Werror, as H9's Windows build of these modules is not held to it either
	  # and -fpermissive: the module sources pass a const edict_t* to reTS's ENTINDEX(edict_t*), which Visual C++ accepts
	  # -w: the module sources warn a great deal under gcc, and AMBuild's worker pipe jams on that much output
	  # and the Visual C++ names the SDK's tier0 headers use, which Metamod-R's own build maps the same way
	  sed -i "s/'-std=c++11'/'-std=gnu++17', '-fpermissive', '-w', '-D_vsnprintf=vsnprintf', '-D_snprintf=snprintf', '-D_vsnwprintf=vswprintf', '-D_stricmp=strcasecmp', '-D_strnicmp=strncasecmp', '-D_strdup=strdup'/; /^      '-Werror',\r\?\$/d" AMBuildScript
	  rm -rf build; mkdir build; cd build
	  python3 ../configure.py --enable-optimize --no-mysql --disable-auto-versioning \
	      --metamod="$WORK/mm-shim" --hlsdk="$WORK/mm-shim/hlsdk" --target-arch=i386 > configure.log 2>&1 || { tail -30 configure.log; exit 1; }
	  nice -n 10 ambuild > "$WORK/amxx-build.log" 2>&1 || { grep -E 'error:|Build failed' "$WORK/amxx-build.log" | sort -u | head -25 | cut -c1-220; exit 1; } )
	[ -n "$(find "$WORK/amxmodx/build" -name 'amxmodx_mm_i386.so' | head -1)" ] || die "AMX Mod X built no amxmodx_mm_i386.so"
}

step_rcbot() {
	say "rcbot: RCBot 1.51b13 with H9's patches, Linux i386"
	command -v clang++ >/dev/null || die "clang++ is missing (linux/h9build-setup.sh)"
	sync_tree "$SRC/rcbot-upstream" "$WORK/rcbot" --exclude .git --exclude '*.o' --exclude '*.obj' --exclude Release
	cp -f "$SRC/rcbot-patch/src/"* "$WORK/rcbot/dlls/"
	# upstream's dir.cpp defines HasSubDirectories in its Windows branch only, and globals.cpp calls it on every platform:
	# Metamod refuses the library (an undefined symbol) without a Linux definition
	cat >> "$WORK/rcbot/dlls/dir.cpp" <<'EOF'

#ifdef __linux__
#include <dirent.h>
#include <string>
#include <sys/stat.h>
// Whether the path holds any sub-directory (the Windows branch above does the same with FindFirstFile)
bool HasSubDirectories(const char* path)
{
	DIR* dir = opendir(path);
	if (!dir)
		return false;
	bool found = false;
	while (struct dirent* entry = readdir(dir))
	{
		if (std::strcmp(entry->d_name, ".") == 0 || std::strcmp(entry->d_name, "..") == 0)
			continue;
		struct stat info;
		const std::string full = std::string(path) + "/" + entry->d_name;
		if (stat(full.c_str(), &info) == 0 && S_ISDIR(info.st_mode))
		{
			found = true;
			break;
		}
	}
	closedir(dir);
	return found;
}
#endif
EOF
	( cd "$WORK/rcbot/dlls"
	  find . -maxdepth 1 -name '*.o' -delete
	  nice -n 10 make -j"$JOBS" 2>&1 | grep -E 'error|Error' | head -20 || true )
	[ -f "$WORK/rcbot/dlls/rcbot_mm.so" ] || die "RCBot built no rcbot_mm.so"
}

# glibc the binary asks for, the floor a host must have
glibc_floor() { objdump -T "$1" 2>/dev/null | grep -oE 'GLIBC_[0-9.]+' | sort -V | tail -1; }

# the .patch note H9 keeps beside every rebuilt library: what it was built from and how
note() { # <file> <text>
	printf '%s\n' "$2" > "$1.patch"
	printf '\nSHA-256 %s\nglibc floor %s\nBuilt %s by linux/build-linux.sh (gcc/clang -m32 on the h9build distro).\n' \
		"$(sha256sum "$1" | cut -d' ' -f1)" "$(glibc_floor "$1")" "$(date -u +%Y-%m-%d)" >> "$1.patch"
}

# Installs the AmxxEasyHttp module and its CA bundle into <amxmodx folder> from the project's own release, which is
# downloaded once (into $WORK/dl) and must match the pinned SHA-256; nothing of it is rebuilt or changed.
install_easy_http() { # <amxmodx folder in the output>
	local dest=$1 zip=${H9_EASYHTTP_ZIP:-$WORK/dl/release_linux_v$EASYHTTP_VERSION.zip}
	if [ ! -f "$zip" ]; then
		command -v curl >/dev/null || die "curl is missing and $zip is not there: download $EASYHTTP_URL and set H9_EASYHTTP_ZIP to it"
		mkdir -p "$(dirname "$zip")"
		curl -fsSL --max-time 300 -o "$zip.part" "$EASYHTTP_URL" || { rm -f "$zip.part"; die "could not download $EASYHTTP_URL (set H9_EASYHTTP_ZIP to a copy of it)"; }
		mv "$zip.part" "$zip"
	fi
	[ "$(sha256sum "$zip" | cut -d' ' -f1)" = "$EASYHTTP_ZIP_SHA256" ] \
		|| die "$zip is not the AmxxEasyHttp $EASYHTTP_VERSION release (its SHA-256 differs from the one pinned in build-linux.sh): delete it, or point H9_EASYHTTP_ZIP at the right file"
	mkdir -p "$dest/modules" "$dest/data"
	python3 -I - "$zip" "$dest" "release_linux_v$EASYHTTP_VERSION" <<'PYEOF'
import sys, zipfile
zpath, dest, top = sys.argv[1:4]
with zipfile.ZipFile(zpath) as z:
    for member, target in (("addons/amxmodx/modules/easy_http_amxx_i386.so", "modules/easy_http_amxx_i386.so"),
                           ("addons/amxmodx/data/amxx_easy_http_cacert.pem", "data/amxx_easy_http_cacert.pem")):
        with open(dest + "/" + target, "wb") as out:
            out.write(z.read(top + "/" + member))
PYEOF
	[ "$(sha256sum "$dest/modules/easy_http_amxx_i386.so" | cut -d' ' -f1)" = "$EASYHTTP_SO_SHA256" ] \
		|| die "easy_http_amxx_i386.so out of $zip is not the pinned one"
	chmod 755 "$dest/modules/easy_http_amxx_i386.so"
	chmod 644 "$dest/data/amxx_easy_http_cacert.pem"
	# the license goes into each folder that holds one of the project's files
	install -m 644 "$SRC/linux/LICENSE-AMXXEASYHTTP.txt" "$dest/modules/easy_http_LICENSE.txt"
	install -m 644 "$SRC/linux/LICENSE-AMXXEASYHTTP.txt" "$dest/data/easy_http_LICENSE.txt"
}

step_assemble() {
	say "assemble: $OUT"
	if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ] && [ ! -f "$OUT/BUILDINFO.txt" ]; then
		die "$OUT exists and is not a folder this script wrote (no BUILDINFO.txt); not replacing it"
	fi
	rm -rf "$OUT"; mkdir -p "$OUT/ts/dlls" "$OUT/ts/addons/metamod/dlls" "$OUT/rcbot/dlls"
	local R="$WORK/reTS/build-i386/dlls/hl.so" M="$WORK/metamod-r/build/metamod_i386.so" E="$WORK/xash3d-fwgs/build"
	[ -f "$R" ] && [ -f "$M" ] && [ -f "$E/engine/xash" ] && [ -f "$WORK/rcbot/dlls/rcbot_mm.so" ] || die "a build step is missing: run rets metamod engine rcbot first"

	install -m 755 "$E/engine/xash" "$OUT/xashds"
	install -m 755 "$E/filesystem/filesystem_stdio.so" "$OUT/filesystem_stdio.so"
	install -m 755 "$R" "$OUT/ts/dlls/ts_i386.so"
	# the engine drops an _i386 or _i686 from the game library name on Linux (GoldSrc did), so Metamod, the game library the
	# engine loads, is installed as metamod.so; the libraries Metamod itself loads keep their names
	install -m 755 "$M" "$OUT/ts/addons/metamod/dlls/metamod.so"
	install -m 755 "$WORK/rcbot/dlls/rcbot_mm.so" "$OUT/rcbot/dlls/rcbot_mm.so"

	local haveamxx=0 am
	am=$(find "$WORK/amxmodx/build" -name 'amxmodx_mm_i386.so' 2>/dev/null | head -1 || true)
	if [ -n "$am" ]; then
		haveamxx=1
		mkdir -p "$OUT/ts/addons/amxmodx/dlls" "$OUT/ts/addons/amxmodx/modules"
		install -m 755 "$am" "$OUT/ts/addons/amxmodx/dlls/amxmodx_mm_i386.so"
		find "$WORK/amxmodx/build" -name '*_amxx_i386.so' -type f -exec install -m 755 {} "$OUT/ts/addons/amxmodx/modules/" \;
	fi

	# ts/gameinfo.txt is what Xash reads; liblist.gam is kept in step. Both come from H9XASH's own, with the Linux
	# game library line pointing at Metamod, which then loads dlls/ts_i386.so (its game table knows it).
	local G="$SRC/H9XASH/ts"
	[ -f "$G/gameinfo.txt" ] && [ -f "$G/liblist.gam" ] || die "no $G/gameinfo.txt and liblist.gam to start from"
	tr -d '\r' < "$G/gameinfo.txt" | sed '/^gamedll_linux/d' \
		| sed 's|^\(gamedll[[:space:]]\+"addons/metamod/dlls/metamod\.dll"\)|\1\ngamedll_linux\t"addons/metamod/dlls/metamod.so"|' > "$OUT/ts/gameinfo.txt"
	grep -q '^gamedll_linux' "$OUT/ts/gameinfo.txt" || die "ts/gameinfo.txt has no gamedll line for Metamod to hang the Linux one on"
	tr -d '\r' < "$G/liblist.gam" | sed 's|^gamedll_linux.*|gamedll_linux "addons/metamod/dlls/metamod.so"|' > "$OUT/ts/liblist.gam"
	grep -q 'metamod.so' "$OUT/ts/liblist.gam" || die "ts/liblist.gam has no gamedll_linux line to point at Metamod"

	# Metamod's plugin list: H9's, with a linux line beside each win32 one
	local P="$SRC/H9XASH/ts/addons/metamod/plugins.ini"
	[ -f "$P" ] || die "no $P"
	tr -d '\r' < "$P" | awk '
		/^win32[ \t]/ { print; l=$0; sub(/^win32/, "linux", l); gsub(/\\/, "/", l)
			sub(/amxmodx_bl_mm\.dll/, "amxmodx_bl_mm_i386.so", l); sub(/amxmodx_mm\.dll/, "amxmodx_mm_i386.so", l); sub(/\.dll/, ".so", l); print l; next }
		{ print }' > "$OUT/ts/addons/metamod/plugins.ini"
	if [ "$haveamxx" = 0 ]; then
		sed -i '/amxmodx/s/^linux/;linux/' "$OUT/ts/addons/metamod/plugins.ini"
	fi

	install -m 755 "$SRC/linux/h9xash_server.sh" "$OUT/h9xash_server.sh"

	note "$OUT/ts/dlls/ts_i386.so" "ts_i386.so: reTS's game library (TSM\\reTS, H9's source changes in it), the hl target built by linux/build-linux.sh rets with reTS's cmake/LinuxToolchain.cmake (gcc -m32, static libstdc++). It is not the stock TS 3.0 ts_i386.so. The H9 changes are those of mp.dll.patch."
	note "$OUT/ts/addons/metamod/dlls/metamod.so" "metamod.so: Metamod-R (rehlds/metamod-r 56590c5) with H9's h9-slots128.patch, built from TSM\\metamod-r by linux/build-linux.sh metamod (built as metamod_i386.so, installed as metamod.so because the engine strips an _i386 suffix from the game library name). Same source as metamod.dll.patch."
	note "$OUT/rcbot/dlls/rcbot_mm.so" "rcbot_mm.so: RCBot 1.51b13 (TSM\\rcbot-upstream) with H9's ten patches (rcbot-patch\\*.patch, the files in rcbot-patch\\src), built by linux/build-linux.sh rcbot with clang++ -m32 from rcbot's own Makefile. Same source as rcbot_mm.dll.patch."
	note "$OUT/xashds" "xashds: Xash3D FWGS built -d (dedicated server, no client, no SDL2) from the patched tree in TSM\\xash3d-fwgs: the H9 patch chain of xash3d-h9-patches\\xash.bat. engine-h9-presence.patch carries a CL_Presence_Frame stub for the dedicated build. Same patches as xash.dll.patch."
	note "$OUT/filesystem_stdio.so" "filesystem_stdio.so: the file system library of the same FWGS build as xashds."
	if [ "$haveamxx" = 1 ]; then
		note "$OUT/ts/addons/amxmodx/dlls/amxmodx_mm_i386.so" "amxmodx_mm_i386.so: AMX Mod X (goldsrc-net/amxmodx 64bit dedff660) with H9's changes (AMXMODX\\H9-SOURCE.txt), built by AMBuild through linux/build-linux.sh amxx. Same source as amxmodx_mm.dll.patch."
		for f in "$OUT"/ts/addons/amxmodx/modules/*_amxx_i386.so; do
			note "$f" "$(basename "$f"): an AMX Mod X module built with amxmodx_mm_i386.so from the same source (AMXMODX\\H9-SOURCE.txt) by linux/build-linux.sh amxx."
		done
		# a third-party release, unchanged: no .patch note (the Windows easy_http_amxx.dll has none either)
		install_easy_http "$OUT/ts/addons/amxmodx"
	fi

	{
		echo "H9XASH-linux: H9's Linux i386 dedicated server build, made by linux/build-linux.sh on $(date -u +%Y-%m-%d)"
		[ "$haveamxx" = 1 ] || echo "WITHOUT AMX Mod X (no AMBuild at build time): none of H9's plugins run in this build."
		[ "$haveamxx" = 0 ] || echo "easy_http_amxx_i386.so is AmxxEasyHttp $EASYHTTP_VERSION as the Next21 Team released it (MIT, not built here): modules/easy_http_LICENSE.txt"
		echo
		( cd "$OUT" && find . -type f \( -name '*.so' -o -name xashds \) | sort | while read -r f; do
			printf '%s  %s  glibc %s  %s bytes\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f" "$(glibc_floor "$f")" "$(stat -c %s "$f")"
		done )
	} > "$OUT/BUILDINFO.txt"
	cat "$OUT/BUILDINFO.txt"
}

# ---- run ------------------------------------------------------------------------------------

mkdir -p "$WORK"
preflight
STEPS=${*:-$ALL}
for s in $STEPS; do
	case " $ALL " in *" $s "*) ;; *) die "unknown step $s (steps: $ALL)" ;; esac
done
for s in $STEPS; do
	if [ $# -eq 0 ] && [[ "$SKIP" == *" $s "* ]]; then echo "(skipping $s: H9_SKIP)"; continue; fi
	"step_$s"
done
say "done"
