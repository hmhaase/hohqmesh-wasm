#!/usr/bin/env python3
"""Bundle HOHQMesh/Examples/*.control into site/examples.json and copy referenced data files."""
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / "HOHQMesh"
SITE = ROOT / "site"
DEFAULT = "2D/AllFeatures"
# Same rule as DATA_KEY in site/control.js (HOHQMesh's reader: exact key, rest of line).
DATA_FILE = re.compile(r"^[ \t]*(?:data )?file[ \t]*=[ \t]*(.*?)[ \t]*$", re.MULTILINE)


def upstream_commit():
    try:
        out = subprocess.run(
            ["git", "-c", "safe.directory=*", "-C", str(UPSTREAM), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


examples = []
for path in sorted((UPSTREAM / "Examples").glob("[23]D/*/*.control")):
    rel = path.relative_to(UPSTREAM / "Examples")
    name = f"{rel.parts[0]}/{rel.parts[1]}"
    text = path.read_text()
    if name == DEFAULT:
        # Skeleton output only has element corners; sem shows the curved high-order elements.
        text, n = re.subn(
            r"^(\s*)plot file format = skeleton",
            r"%  plot file format changed from skeleton to sem to show curved elements\n\1plot file format = sem",
            text,
            flags=re.MULTILINE,
        )
        if n != 1:
            raise SystemExit(f"{path}: expected one 'plot file format = skeleton' line, found {n}")
    for data in filter(None, DATA_FILE.findall(text)):
        dst = SITE / data
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(UPSTREAM / data, dst)
    examples.append({"name": name, "dim": rel.parts[0], "control": text})

examples.sort(key=lambda e: (e["name"] != DEFAULT, e["name"]))
info = {"hohqmeshCommit": upstream_commit(), "examples": examples}
(SITE / "examples.json").write_text(json.dumps(info, indent=1))
print(f"{len(examples)} examples written")
