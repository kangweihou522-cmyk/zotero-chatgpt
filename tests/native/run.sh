#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
smoke_dir="${NATIVE_SMOKE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zotero-chatgpt-pdf-native}"
mkdir -p "$smoke_dir"
profile="$(mktemp -d "$smoke_dir/profile.XXXXXX")"
mkdir -p "$profile/extensions" "$profile/data"
cp -R "$repo_dir/tests/native/driver" "$profile/extensions/chatgpt-pdf-smoke@zotero.community"
python3 "$repo_dir/scripts/build.py"
cp "$repo_dir"/dist/zotero-chatgpt-pdf-*.xpi "$profile/plugin.xpi"

if [[ -z "${ZOTERO_BIN:-}" ]]; then
  curl --fail --location --retry 2 --max-time 120 \
    https://download.zotero.org/client/release/10.0.8/Zotero-10.0.8_linux-x86_64.tar.xz \
    --output "$smoke_dir/zotero.tar.xz" > "$smoke_dir/zotero-download.log" 2>&1
  mkdir -p "$smoke_dir/zotero"
  tar -xf "$smoke_dir/zotero.tar.xz" -C "$smoke_dir/zotero"
  ZOTERO_BIN="$(find "$smoke_dir/zotero" -maxdepth 3 -type f -name zotero -print -quit)"
fi
if [[ -z "${ZOTERO_TEST_PYTHON:-}" ]]; then
  python3 -m venv "$smoke_dir/renderer"
  "$smoke_dir/renderer/bin/python" -m pip install -r "$repo_dir/requirements.txt" > "$smoke_dir/pip.log" 2>&1
  "$smoke_dir/renderer/bin/babeldoc" --warmup > "$smoke_dir/assets.log" 2>&1
  ZOTERO_TEST_PYTHON="$smoke_dir/renderer/bin/python"
fi
export ZOTERO_TEST_PYTHON

"$ZOTERO_TEST_PYTHON" - "$profile" <<'PY'
import json
from pathlib import Path
import sys
import pymupdf

profile = Path(sys.argv[1])
with pymupdf.open() as document:
    for text in ("MARS SURFACE SAMPLE", "Photosynthesis converts light energy into chemical energy."):
        page = document.new_page(width=612, height=792)
        page.insert_text((65, 100), text, fontsize=12)
    document.save(profile / 'fixture.pdf')
prefs = {
    'app.update.enabled': False,
    'app.update.auto': False,
    'extensions.update.enabled': False,
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 15,
    'extensions.zotero.useDataDir': True,
    'extensions.zotero.dataDir': str(profile / 'data'),
    'extensions.zotero.firstRun.skipFirefoxProfileAccessCheck': True,
    'extensions.zotero.firstRunGuidance': False,
    'extensions.zotero.firstRun2': False,
    'extensions.zotero.sync.autoSync': False,
    'extensions.zotero.automaticScraperUpdates': False,
    'extensions.zotero.backup.numBackups': 0,
    'extensions.zoteroOpenOfficeIntegration.skipInstallation': True,
    'extensions.zotero.debug.log': True,
}
(profile / 'prefs.js').write_text(''.join(
    f'user_pref({json.dumps(key)}, {json.dumps(value)});\n'
    for key, value in prefs.items()
))
PY

host_exit=0
MOZ_NO_REMOTE=1 NO_EM_RESTART=1 timeout --kill-after=10s 240s \
  xvfb-run -a "$ZOTERO_BIN" -no-remote -profile "$profile" -ZoteroDebugText \
  > "$smoke_dir/zotero.log" 2>&1 || host_exit=$?
if [[ ! -f "$profile/result.json" ]]; then
  tail -c 12000 "$smoke_dir/zotero.log"
  printf '%s\n' "Zotero did not produce a smoke report (exit $host_exit)."
  exit 1
fi
cp "$profile/result.json" "$smoke_dir/result.json"
if ! grep -q '"success": true' "$profile/result.json"; then
  grep -nEi 'JavaScript error|chrome://zotero-chatgpt-pdf|Exception|Could not' "$smoke_dir/zotero.log" | tail -n 35 || true
fi
"$ZOTERO_TEST_PYTHON" - "$smoke_dir/result.json" "$host_exit" <<'PY'
import json
from pathlib import Path
import sys
import pymupdf

report = json.loads(Path(sys.argv[1]).read_text())
print(json.dumps(report, indent=2))
assert report["success"] and sys.argv[2] == "0", report.get("error")
with pymupdf.open(report["outputs"]["original"]) as original, \
        pymupdf.open(report["outputs"]["mono"]) as mono, \
        pymupdf.open(report["outputs"]["dual"]) as dual, \
        pymupdf.open(report["outputs"]["alternate"]) as alternate:
    assert len(original) == 2 and "MARS SURFACE SAMPLE" in original[0].get_text()
    assert len(mono) == len(dual) == 1
    assert dual[0].rect.width >= mono[0].rect.width * 1.9
    normalized = lambda page: "".join(page.get_text().split())
    assert "光合作用将光能转化为化学能" in normalized(mono[0])
    assert "光合作用将光能转化为化学能" in normalized(dual[0])
    assert "Photosynthesis converts light energy" in dual[0].get_text()
    assert "MARS SURFACE SAMPLE" not in dual[0].get_text()
    assert len(alternate) == 2 and "Photosynthesis converts light energy" in alternate[0].get_text()
    assert "光合作用将光能转化为化学能" in normalized(alternate[1])
PY
