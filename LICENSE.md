# Licensing: which license covers which part of this repository

This file says which license applies to which folder, and why two of them are kept apart. It states what the
maintainers intend and how they keep the code separate. It is not legal advice.

The repository root carries no license text: neither the GPLv3 nor the Half-Life SDK license is placed there, because
neither covers the repository as a whole. This file is the root's statement of licensing. Each license text sits in the
folders it covers, and the license texts of other people's work are gathered in [THIRD_PARTY_LICENSES/](THIRD_PARTY_LICENSES/).

## The short version

| Part | License | Where the license text is |
|---|---|---|
| **The gamemode plugin code** (the game modes and everything H9 wrote around them) | **GPLv3** | `LICENSE-GPLV3.txt` in the plugin folders: `src/`, `AMXMODX/plugins/`, `H9XASH/ts/addons/amxmodx/scripting/`; and in the folders of the code that serves the plugins: `h9web/`, `p2p/`, `serverlist-bot/`, `tools/` |
| **The mod code** (the game and client libraries of the mod) | **Half-Life SDK license**: free of charge only, and the license text goes with every distribution. **Not GPLv3.** | [reTS/LICENSE](reTS/LICENSE), and a copy beside the built libraries in `H9XASH/ts/dlls/` and `H9XASH/ts/cl_dlls/` |
| **MIT and Apache-2.0 components** (permissive licenses) | **MIT** or **Apache License 2.0**, each as its author gave it. Both may be included in a GPLv3 project (Apache 2.0 is compatible with the GPLv3, not with the GPLv2), so they sit beside the GPLv3 code without a conflict | beside each component, listed below |
| **Other people's work** | each keeps its own license | beside it, and gathered in [THIRD_PARTY_LICENSES/](THIRD_PARTY_LICENSES/) (the list is below) |

The plugin code is the AMX Mod X plugins (`ts_matchmode`, `ts_assault`, `ts_ctf`, `ts_uplink`, `ts_survival`,
`ts_mechwarrior`, `ts_rtv`, `ts_advertise`, the `h9_*` plugins, `tsrp_roambots`, ...) with their configs and presets
and H9's own additions to Apollo RP. The mod code is `reTS/` (`dlls/`, `cl_dll/`, `common/`, `pm_shared/`, ...) and what
is built from it: `H9XASH/ts/dlls/mp.dll` and `H9XASH/ts/cl_dlls/client.dll` (with their `.patch` notes and `.so` builds).

So: the GPLv3 is over the gamemode plugin code, and the Half-Life SDK license pertains to the mod code only.
The one does not reach into the other.

## Older revisions

The history of this repository is long and is not rewritten. Older revisions carried a license file at the root and a
README line that named the GPLv3 for the project as a whole. That was never the intent: it stood until the difference
between the two licenses was noticed, and the licenses were then placed in the folders where the work they cover is,
not over the whole codebase. The scope stated here is the maintainers' statement for every revision: legally the
Half-Life SDK license applies to the mod work, and the GPLv3 applies to the gamemode code, the scripts and the code and
data around them. The mod code was never anything but a work built on Valve's SDK and under its terms; nothing in the
history relicenses it. Where an older revision says otherwise, this file says what was meant.

## Why they are kept apart

The Half-Life SDK license lets you modify and distribute the SDK and a mod built on it, but only for free, and it
requires its own license text with any distribution. The GPLv3 lets anyone use, change and redistribute the work
on any terms they like (a fee included) and forbids adding restrictions of its own. Those two sets of terms cannot
be satisfied by one and the same work, so code under the one license must not be combined with code under the
other. The project therefore keeps them as two separate bodies of code.

## How the separation is kept

- The plugins are separate programs. They are AMX Mod X scripts run by AMX Mod X's own virtual machine, and they
  meet the mod only at run time, through the interfaces the game engine and AMX Mod X offer: user messages, console
  variables and commands, client commands, AMX Mod X's modules and their natives, and data files. They are not
  linked with the mod's libraries and the mod's libraries do not contain them.
- No Half-Life SDK source is copied into a plugin, a tool or a page, and no GPLv3 code is copied into `reTS/`. A
  number both sides need (a weapon id, a message name) is written down on each side on its own.
- A change that would need a file to be shared by both sides is raised with the maintainers first; it goes in
  neither tree until the license of that file is settled.
- The compiled plugins (`.amxx`) are GPLv3 and their source is in this repository. The compiled mod libraries
  (`mp.dll`, `client.dll`) are under the Half-Life SDK license and are free of charge only.

## MIT and Apache 2.0: permissive licenses the GPLv3 can contain

MIT and Apache 2.0 let their code be used, changed and redistributed, in a GPLv3 project too, as long as their
copyright notices and license texts stay with them. They are kept separate from the two bodies of code above: each
component keeps its own license text beside it, and is not relicensed.

| License | Component | Where |
|---|---|---|
| MIT | **SMAK**, the map kit (git submodule of [deoroot/SMAK](https://github.com/deoroot/SMAK)) | `SMAK/` |
| MIT | **compts**, the Elo plugin backend (Xjiro) | `compts/LICENSE.MD` |
| MIT | **bat2exe** (dehoisted) | `bat2exe/LICENSE.md` |
| MIT | **AMD FidelityFX Super Resolution 1** (the scene upscaler in the engine patch) | `H9XASH/ref_gl.FSR1-LICENSE.txt` |
| MIT | **ONNX Runtime** (Microsoft; runs the speech model) | `H9XASH/ts/h9tts/bin/LICENSE-onnxruntime-mit.txt` |
| Apache 2.0 | **Kokoro** speech model and voices (hexgrad) | `h9tts/LICENSE-kokoro-apache-2.0.txt`, `H9XASH/ts/h9tts/` |
| Apache 2.0 | **misaki**, the phoneme dictionaries and algorithm (hexgrad) | `h9tts/LICENSE-misaki-apache-2.0.txt`, `H9XASH/ts/h9tts/` |

Other permissive files keep their notices beside them too: **AsmJit** (zlib license, `AMXMODX/extern/asmjit/`) and
Microsoft's **WebView2** loader (`H9XASH/h9webview.WebView2-LICENSE.txt`).

## Third-party license texts, gathered

[THIRD_PARTY_LICENSES/](THIRD_PARTY_LICENSES/) holds a copy of each license text below. The originals stay beside the code.

| File | What it is for | License |
|---|---|---|
| `AMXModX-LICENSE-INFORMATION.txt` | AMX Mod X (AMXMODX/) | GPLv3 with the AMX Mod X module exception |
| `AMXModX-ACKNOWLEDGEMENTS.txt` | AMX Mod X (AMXMODX/) | acknowledgements of AMX Mod X's own third-party code |
| `Metamod-R-GPLv3.txt` | Metamod-R (metamod-r/) | GPLv3 |
| `HLFC-GPLv2.txt` | HLFC (HLFC/) | GPLv2 |
| `SDHLT-goldsrc-net-LICENSE.md` | SDHLT map compilers (export-map/sdhlt-goldsrc-net/) | GPL with the Valve SDK and id Software terms its text names |
| `SDHLT-v1.3.1-xash-LICENSE.md` | SDHLT map compilers, Xash build (export-map/compilers-xash/) | GPL with the Valve SDK and id Software terms its text names |
| `SMAK-MIT.txt` | SMAK, the map kit (git submodule of deoroot/SMAK) | MIT |
| `compts-MIT.md` | compts, the Elo plugin backend (compts/) | MIT |
| `bat2exe-MIT.md` | bat2exe (bat2exe/) | MIT |
| `AMD-FSR1-MIT.txt` | AMD FidelityFX Super Resolution 1 (the scene upscaler) | MIT |
| `ONNX-Runtime-MIT.txt` | ONNX Runtime (speech) | MIT |
| `ONNX-Runtime-ThirdPartyNotices.txt` | ONNX Runtime (speech) | notices of ONNX Runtime's own third-party code |
| `Kokoro-Apache-2.0.txt` | Kokoro speech model and voices (hexgrad) | Apache License 2.0 |
| `misaki-Apache-2.0.txt` | misaki phoneme dictionaries and algorithm (hexgrad) | Apache License 2.0 |
| `h9tts-NOTICE.txt` | the speech package (h9tts/) | notice of the speech package |
| `Microsoft-WebView2-BSD.txt` | WebView2 loader (H9XASH/) | Microsoft's BSD-style license |
| `AsmJit-zlib.md` | AsmJit (AMXMODX/extern/asmjit/) | zlib |
| `PCRE-LICENCE.txt` | PCRE (AMXMODX/tools/pcre/) | PCRE's BSD-style licence |
| `AmxxEasyHttp-LICENSE.txt` | AmxxEasyHttp module (the easy_http files) | AmxxEasyHttp's own license text |
| `AMBuild-LICENSE.txt` | AMBuild (the Linux build) | AMBuild's license |
| `Asset-PPSh-41-ATTRIBUTION.txt` | PPSh-41 weapon models (zillious) | Creative Commons, attribution |
| `Asset-LaserRifle-ATTRIBUTION.txt` | laser rifle weapon models (Jett Spaulding) | Creative Commons, attribution |

## Everything else

- **Xash3D FWGS** (the engine) is a separate, nested project: see [H9XASH/UNLICENSED.MD](H9XASH/UNLICENSED.MD). The
  patches in `xash3d-h9-patches/` are patches to it.
- **AMX Mod X** (`AMXMODX/`) is GPLv3 with its module exception (its license information is in the folder); **Metamod-R**
  (`metamod-r/`) is under the GPLv3 text in its `LICENSE`; **RCBot** and `rcbot-patch/` follow RCBot's own license;
  **AmxxEasyHttp** (the `easy_http` module) and **AMBuild** carry their license beside them (`easy_http_LICENSE.txt`,
  `linux/LICENSE-*.txt`).
- **Other GPL tools stay separate programs with their own terms**: **HLFC** (`HLFC/`, GPLv2) and the **SDHLT map
  compilers** (`export-map/compilers-xash/`, `export-map/sdhlt-goldsrc-net/`, GPL with the Valve SDK and id Software
  terms their `LICENSE.md` names). They are run, never linked into the plugin code.
- **Apollo RP** (`apollo-rp/`) is by the Apollo RP Team. Its repository had no license file when copied, and it ships
  here with its authors' agreement ([apollo-rp/ORIGIN.txt](apollo-rp/ORIGIN.txt)). Only what H9 added to it is H9's
  own work, under the GPLv3.
- **Models, sounds and pictures** keep the terms of their makers (some are Creative Commons with attribution, see
  the `*_ATTRIBUTION.txt` files). **The Specialists 3.0** and its assets belong to their makers, and everything from
  Valve to Valve. Credits are in [creds_attribution.txt](creds_attribution.txt); the non-commercial notice is
  [NON_COMMERCIAL.MD](NON_COMMERCIAL.MD).

When a folder has a license file of its own, that file wins for that folder.
