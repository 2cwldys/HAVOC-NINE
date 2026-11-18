"""build-egg.py -- turn egg-h9xash.yml into the egg-h9xash.json a Pterodactyl panel imports.

The panel's own export is machine-written JSON with no comments in it, which is a miserable thing
to maintain. So the source of truth here is a commented YAML file, the install script is an
ordinary shell script beside it, and this puts the two together in the shape the panel wants.

    python build-egg.py            write egg-h9xash.json
    python build-egg.py --check    exit 1 if the JSON is not what the YAML and install.sh say
                                   (for CI, so a forgotten regeneration cannot ship)

Needs PyYAML. Nobody has to run this to USE the egg: egg-h9xash.json is committed.

Three details of the format that are easy to get wrong, and are handled here:

  * meta.version must be "PTDL_v1". The panel refuses anything else.
  * config.files, config.startup and config.logs are JSON *strings*, not objects. A nested object
    imports as an empty config and the server then never reports as started.
  * the key is "images" (a list), not "docker_images".
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
YML = HERE / "egg-h9xash.yml"
INSTALL = HERE / "install.sh"
OUT = HERE / "egg-h9xash.json"

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is needed to regenerate the egg:  pip install pyyaml\n"
             "(egg-h9xash.json is committed, so this is only needed if you edit the YAML.)")


def build_number(spec: str) -> str:
    """The build this egg is for, from the file the YAML points at (dockerfiles/VERSION)."""
    p = (HERE / spec).resolve()
    if not p.is_file():
        return "dev"
    return p.read_text(encoding="ascii").strip().split()[0] or "dev"


def exported_at() -> str:
    """A stamp the panel shows. Taken from git so regenerating twice gives the same file: a
    wall-clock time would make every rebuild a diff, and this file is committed."""
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%cI"], cwd=HERE,
                             capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "1970-01-01T00:00:00+00:00"


def install_script(spec: dict) -> str:
    """install.sh, with the packages the installer image lacks installed ahead of it."""
    body = INSTALL.read_text(encoding="utf8")
    packages = spec.get("packages") or []
    if not packages:
        return body
    head = "\n".join([
        "#!/bin/bash",
        "# Prepended by build-egg.py from the `install.packages` list in egg-h9xash.yml: the",
        "# installer image is a bare Debian and has none of these.",
        "set -e",
        "apt-get update",
        "apt-get install -y --no-install-recommends " + " ".join(packages),
        "",
    ])
    # the script's own shebang would be stranded in the middle, so it goes
    rest = body
    if rest.startswith("#!"):
        rest = rest.split("\n", 1)[1] if "\n" in rest else ""
    return head + rest


def main() -> int:
    spec = yaml.safe_load(YML.read_text(encoding="utf8"))

    cfg = spec.get("config") or {}
    inst = spec.get("install") or {}
    build = build_number(spec.get("build_from_file", "../VERSION"))

    description = " ".join(str(spec["description"]).split())
    description += f"\n\nThis egg is generated for H9XASH build {build}."

    egg = {
        "_comment": ("GENERATED from dockerfiles/pterodactyl/egg-h9xash.yml by build-egg.py. "
                     "Edit the YAML and install.sh, not this file. "
                     "HAVOC 9 -- https://github.com/2cwldys/HAVOC-NINE"),
        "meta": {"version": "PTDL_v1", "update_url": None},
        "exported_at": exported_at(),
        "name": spec["name"],
        "author": spec["author"],
        "description": description,
        "features": spec.get("features") or [],
        "images": spec["images"],
        "file_denylist": spec.get("file_denylist") or [],
        "startup": " ".join(str(spec["startup"]).split()),
        "config": {
            # stringified on purpose: see the note at the top of this file
            "files": json.dumps(cfg.get("files") or {}),
            "startup": json.dumps({"done": cfg["startup_done"]}),
            "logs": json.dumps(cfg.get("logs") or {}),
            "stop": cfg.get("stop", "quit"),
        },
        "scripts": {
            "installation": {
                "script": install_script(inst),
                "container": inst.get("container", "debian:bookworm-slim"),
                "entrypoint": inst.get("entrypoint", "bash"),
            }
        },
        "variables": [
            {
                "name": v["name"],
                "description": " ".join(str(v["description"]).split()),
                "env_variable": v["env_variable"],
                "default_value": str(v.get("default_value", "")),
                "user_viewable": bool(v.get("user_viewable", True)),
                "user_editable": bool(v.get("user_editable", True)),
                "rules": v.get("rules", "nullable|string"),
            }
            for v in spec.get("variables") or []
        ],
    }

    text = json.dumps(egg, indent=4, ensure_ascii=False) + "\n"

    if "--check" in sys.argv:
        if not OUT.is_file():
            print("egg-h9xash.json is missing: run  python build-egg.py")
            return 1
        if OUT.read_text(encoding="utf8") != text:
            print("egg-h9xash.json is out of date with egg-h9xash.yml or install.sh.")
            print("Run  python build-egg.py  and commit the result.")
            return 1
        print(f"egg-h9xash.json is up to date (build {build})")
        return 0

    OUT.write_text(text, encoding="utf8")
    print(f"wrote {OUT.name}: build {build}, {len(egg['variables'])} variables, "
          f"{len(egg['scripts']['installation']['script'].splitlines())}-line install script")
    return 0


if __name__ == "__main__":
    sys.exit(main())
