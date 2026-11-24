#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Build a deterministic, installable Zotero XPI."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent


def build(output):
    addon = ROOT / "addon"
    manifest = json.loads((addon / "manifest.json").read_text(encoding="utf-8"))
    target = addon / "content" / "render_pdf.py"
    engine_pin = (ROOT / "requirements.txt").read_text(encoding="utf-8").strip()
    if engine_pin != "BabelDOC==" + target.read_text(encoding="utf-8").split('ENGINE_VERSION = "')[1].split('"')[0]:
        raise SystemExit("requirements.txt and the PDF worker specify different BabelDOC versions")
    artifact = output / f"zotero-chatgpt-pdf-{manifest['version']}.xpi"
    output.mkdir(parents=True, exist_ok=True)
    files = {
        file.relative_to(addon).as_posix(): file
        for file in addon.rglob("*")
        if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc"
    }
    files["LICENSE"] = ROOT / "LICENSE"
    with ZipFile(artifact, "w") as archive:
        for name, file in sorted(files.items()):
            entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, file.read_bytes())
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    (output / f"{artifact.name}.sha256").write_text(f"{digest}  {artifact.name}\n", encoding="utf-8")
    return artifact


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    print(build(args.output))
