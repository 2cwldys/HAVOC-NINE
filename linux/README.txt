linux/ -- H9's Linux build
===========================

  build-linux.sh        every build step (reTS, Metamod-R, the dedicated engine, AMX Mod X, RCBot) and the
                        layout of H9XASH-linux/ (run from Linux, or through ../build-linux.sh and
                        ../build-linux.cmd)
  h9build-setup.sh      the build tools (32-bit toolchain, cmake, clang, nasm; --with-ambuild adds AMBuild)
  ../wsl_install.bat    Windows side: makes the WSL2 distro h9build these run in (wsl_install.ps1)
  ../build-linux.cmd    Windows side: runs build-linux.sh in that distro (build-linux.ps1); ../build-linux.sh does the
                        same on a Linux machine
  h9xash_server.sh      the native Linux dedicated server's launcher (it goes into H9XASH-linux/)
  LICENSE-AMBUILD.txt   AMBuild's BSD 3-Clause license (AMBuild builds AMX Mod X and is installed by
                        h9build-setup.sh --with-ambuild; it is not shipped here). Keep it in this folder.
  LICENSE-AMXXEASYHTTP.txt  AmxxEasyHttp's MIT license and where its Linux module comes from: build-linux.sh
                        assemble downloads release 1.4.0 (the easy_http module ts_advertise, h9_presence,
                        h9_community, h9_compete and h9_rank need), checks its SHA-256 and installs it with the
                        license beside it. Keep it in this folder.

H9XASH-linux/ is what the build writes and is not tracked by git (.gitignore): everyone who builds makes
their own. The plan and the status are in ../docs/LINUX_SUPPORT.txt.
