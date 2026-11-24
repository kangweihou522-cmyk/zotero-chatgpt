# SPDX-License-Identifier: AGPL-3.0-only
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import unittest


module_path = Path(__file__).resolve().parents[1] / "addon/content/render_pdf.py"
spec = importlib.util.spec_from_file_location("render_pdf", module_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RendererProtocolTest(unittest.TestCase):
    def test_page_selection_validates_and_combines_ranges(self):
        self.assertEqual(worker.selected_pages("3,1-3", 5), [1, 2, 3])
        self.assertEqual(list(worker.selected_pages("", 3)), [1, 2, 3])
        for invalid in ("0", "5-4", "6", "1,,2", "1e1", "1-"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(worker.WorkerError):
                    worker.selected_pages(invalid, 5)

    def test_matching_translation_and_probe(self):
        sink = BytesIO()
        source = BytesIO('{"type":"translation","id":1,"text":"译文"}\n'.encode())
        bridge = worker.TranslationBridge(worker.Pipe(source, sink))
        self.assertIsNone(bridge.translate(None))
        self.assertEqual(bridge.translate("第一段"), "译文")
        self.assertEqual(bridge.count, 1)
        self.assertEqual(json.loads(sink.getvalue()), {"type": "translate", "id": 1, "prompt": "第一段"})

    def test_failure_cannot_turn_into_a_successful_retry(self):
        sink = BytesIO()
        source = BytesIO(b'{"type":"translation","id":2,"text":"wrong id"}\n')
        bridge = worker.TranslationBridge(worker.Pipe(source, sink))
        for _ in range(2):
            with self.assertRaises(worker.WorkerError):
                bridge.translate("text")
        self.assertEqual(bridge.count, 0)
        self.assertEqual(sink.getvalue().count(b"\n"), 1)


if __name__ == "__main__":
    unittest.main()
