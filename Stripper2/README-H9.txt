Stripper2 on HAVOC 9 -- MODIFIED to use Metamod-R
=================================================

This copy of Stripper2 (the GoldSrc entity stripper, originally by Alfred Reynolds / botman, GPLv2 or
newer -- see src/GPL.txt) is MODIFIED. The source in src/dlls now builds against Metamod-R, the metamod
the H9XASH engine runs, instead of the classic Metamod SDK the original was written for. The changes are
small and touch only the metamod glue, not the entity-stripping logic:
  - src/dlls/h_export.cpp   -- include meta_api.h and export GiveFnptrsToDll with C_DLLEXPORT
  - src/dlls/sdk_util.h     -- NEW: declares the two helpers stripper2_api.cpp uses
  - src/dlls/stripper2_api.cpp -- plugin-info string globals are const char* (Metamod-R's plugin_info_t)
  - src/dlls/config.cpp     -- one for-loop variable declared locally (C++98 scope)

THE ORIGINAL, UNMODIFIED SOURCE IS KEPT AS THE SOURCE OF TRUTH:
  - The exact H9 changes are recorded as a reversible patch: h9_src_patches/metamod-r-port.patch.
    Reverse it on src/dlls to recover the pristine upstream source.
  - The original is also the first commit of this folder in git history (before the port), untouched.
  - The original prebuilt plugin (the classic-Metamod Windows binary) is plugin/stripper2_mm.dll, with
    its ReadMe.txt and cfgs, untouched.

WHAT SHIPS is the NEW (Metamod-R) source and the binaries built from it:
  Linux:   Stripper2/build-linux.sh    -> Stripper2/dist/stripper2_mm_i386.so
  Windows: Stripper2/build-windows.ps1 -> Stripper2/dist/stripper2_mm.dll
These mirror EntMod4/src/build-linux.sh and build-windows.ps1.
