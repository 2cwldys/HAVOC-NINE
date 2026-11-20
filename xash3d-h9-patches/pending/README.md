# pending

Engine work that is written but is **not in the patch chain yet**.

Nothing in this folder is applied, built or verified. `xash.bat` never looks here: it calls
each patch by name from an explicit list of `call :patch` lines, so a file that is not named
there does nothing at all. The same is true of packaging -- `xash3d-h9-patches` reaches a
release only through named files under `overlay\`, never as a folder, so nothing here ships.

## Why a folder instead of a .patch

`docs\ADD_AN_ENGINE_CHANGE.txt` is the process, and it is strict for good reasons: a patch has
to be cut against the tree that every earlier patch produces, checked forward *and* in
reverse, wired into `xash.bat` at the right position, and recorded in
`patches\PATCH_CHANGELOG.md`. The Submodule Engine Build Scan then re-verifies the whole chain
against pristine upstream on every push that touches `patches\` or `xash.bat`.

A `.patch` that has never been applied or compiled cannot honestly meet any of that. Writing
one anyway would put an unverified link into a 63-patch chain and turn CI red for whoever
pushes next -- and section 1 of that document is explicit that a patch which quietly stops
applying fails for the next person, not the one who broke it.

So work lives here as plain source until someone applies it, builds it, and takes it through
`ADD_AN_ENGINE_CHANGE.txt` properly. At that point it leaves this folder and becomes a real
patch with a changelog entry.

## What is here

| folder | what it is | state |
|---|---|---|
| `engine-h9-clientid7/` | h9_clientid as seven base36 characters, to spend less userinfo | not built; its web half is on `main` already and is safe on its own |

Each folder carries its own `HOOKS.md` naming the exact files, line numbers and edits, so the
person who picks it up is not reconstructing it from scratch.
