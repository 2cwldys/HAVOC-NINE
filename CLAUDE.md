# CLAUDE.md

Working rules for Claude in this repo. The build, export and engine details are in CONTEXT.md. A barebones copy of the build tools is in tools.zip.

## Standing rules

### Git
- Do not commit, amend, rebase, rename or move a branch, tag, or push. This applies to this repo and to every other repo, including the local engine clone (D:\Downloads\TSM\xash3d-fwgs, branch h9). Show the change as a diff or patch file, then ask.
- A plan approval is not permission to commit.
- Creating and editing files in the working tree is fine. The user makes the commits.

### Editing
- Back up before changing anything a build overwrites: DLLs, .patch files, ENGINE.txt, server configs, compiled plugins.
- Change only what was asked. Do not remove or tidy surrounding code, imports or variables as a side effect. Suggest cleanups, and wait for a yes.
- If a bug traces back to a feature nobody asked for, offer to remove the feature rather than patching the mechanism.
- Code comments describe what the code does now, in the present tense. No references to plans, to "Part N" labels, or to what the code used to do.
- Edit the source of truth only. For TS work that is D:\Downloads\TSM. Never edit export\, H9XASH\ or the generated copies. The repo copy of H9XASH may be edited by hand, because export.bat keeps newer files.
- Line endings: most TS files are CRLF. Never run `sed -i` on them, because it converts the whole file to LF. Check the byte count before editing. Use an exact-string replace: read the bytes, convert the search and replace text to the file's own line ending, require exactly one match, and write the file back.
- BYOND (.dm) sources are ASCII only. Write "--" where an em dash would go.

### Builds, exports and patches
- Build TS plugins with build.bat only. It copies the sources into the game folder, compiles with the game's amxxpc.exe, deploys, registers the plugins, runs `xash.bat addons`, and exports. Never copy sources or binaries into the game folder by hand.
- build.bat overwrites the game's copy of ts_matchmode.cfg on every run. Edit the copy in D:\Downloads\TSM.
- COMMANDS.txt and ts_matchmode.cfg change in the same edit as any command or cvar.
- A build deploys to the live install. Run it when the user wants the change live. After a plugin change the server needs a full restart, not an AMXX reload. H9XASH needs its own copy of a new xash.dll.
- export\ is generated. Never edit it. export.bat mirrors it into D:\GIT Storage\ts_h9_team_elimination with `robocopy /E /XO` and no purge. A file removed from export\ has to be removed from the repo by hand.
- Every DLL that ships carries a `<dll>.patch` beside it, everywhere it ships: live install, export, H9XASH and the repo. xash.bat writes these from git. Never hand-edit a .patch.
- dllmerge.ps1 only adds to a .patch. History blocks are kept, lines the new diff drops move into the history, and an empty new diff over a non-empty one is refused. Keep that behaviour if you change the script.
- Engine work (`xash.bat engine`) builds the h9 branch of the FWGS clone. Changing the engine source needs the commit OK above.
- Keep secrets out of TSM. `tsm_ad_token` in ts_advertise.cfg is the Discord bot token. It lives only in the game folder's copy. Check it by length, never print its value.
- Check .patch file chains for any code added by other agents, before building anything, to prevent overwrites.

### Shell
- Run .bat and .cmd files by full path, through cmd, with path conversion off: `MSYS_NO_PATHCONV=1 cmd /c "C:\full\path\build.bat <nul"`. The agent shell sets NoDefaultCurrentDirectoryInExePath=1, so bare names fail.
- Keep each bash heredoc under about 8 KB. For bigger files, use the Write tool, or write in several pieces.
- Never rely on `\\` in a bash command: it arrives as a single backslash. Build Windows paths with the Write tool, with PowerShell, or with chr(92) in Python.
- After editing a .bat or .cfg, scan the file for control bytes below 32, other than tab, CR and LF.

### The live game
- Never launch or kill a game or server while the user may be playing it.
- Never run taskkill by image name, because it kills every instance. If a test instance is unavoidable, kill only the PID you started.

### Diagnosis and verification
- When the user reports a bug and has no more information, trace the code path and name the mechanism. Do not stall on log archaeology.
- Do not suggest "did you recompile or restart" as the explanation for a bug that still reproduces. Find the remaining cause.
- Verify in proportion. Run the check that answers the question, then stop. The user has stopped runs that were not needed.
- In plan mode, edit only the plan file, until the user approves the plan.

## Project rules

### TS Match Mode and H9XASH (D:\Downloads\TSM)
- The rules above apply in full: build.bat for the plugin, xash.bat for the engine and the H9XASH layout, dllmerge for every .patch.
- The stock TS 3.0 base and the Valve content come from the user's own installs. Never copy them into a repo.
