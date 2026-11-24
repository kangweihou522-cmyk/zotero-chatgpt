# SPDX-License-Identifier: AGPL-3.0-only
"""Render PDFs locally, delegating text translation to the Zotero add-on."""
import asyncio
from importlib.metadata import version
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sys
import threading


ENGINE_VERSION = "0.7.1"
MAX_FRAME = 2 * 1024 * 1024
LANGUAGES = {
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "ru": "Russian",
}
OUTPUT_FILES = {"mono": "mono.pdf", "dual": "dual.pdf"}


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Pipe:
    def __init__(self, source, sink):
        self.source = source
        self.sink = sink
        self.write_lock = threading.Lock()

    def read(self):
        line = self.source.readline(MAX_FRAME + 1)
        if not line or len(line) > MAX_FRAME:
            raise WorkerError("pipe", "与 Zotero 的排版进程通信中断。")
        try:
            data = json.loads(line)
        except ValueError as error:
            raise WorkerError("pipe", "排版进程收到无效消息。") from error
        if not isinstance(data, dict):
            raise WorkerError("pipe", "排版进程收到无效消息。")
        return data

    def send(self, type_, **contents):
        data = json.dumps({"type": type_, **contents}, ensure_ascii=True).encode("ascii") + b"\n"
        if len(data) > MAX_FRAME:
            raise WorkerError("pipe", "需要翻译的文字块过大。请缩小页码范围。")
        with self.write_lock:
            self.sink.write(data)
            self.sink.flush()


class TranslationBridge:
    def __init__(self, pipe):
        self.pipe = pipe
        self.lock = threading.Lock()
        self.count = 0
        self.failure = None

    def translate(self, prompt):
        # BabelDOC checks the translator with None before starting the job.
        if prompt is None:
            return None
        with self.lock:
            if self.failure:
                raise self.failure
            try:
                request_id = self.count + 1
                self.pipe.send("translate", id=request_id, prompt=prompt)
                response = self.pipe.read()
                if response.get("type") != "translation" or response.get("id") != request_id:
                    raise WorkerError("pipe", "译文响应与当前排版请求不匹配。")
                text = response.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise WorkerError("translation", "ChatGPT 未返回完整译文。")
                self.count = request_id
                return text.strip()
            except WorkerError as error:
                self.failure = error
                raise


def check_engine():
    try:
        if version("BabelDOC") != ENGINE_VERSION:
            raise ValueError("Unsupported engine version")
        # Check native dependencies as well as the Python package metadata.
        from babeldoc import _rust_il  # noqa: F401
        from babeldoc.docvision.doclayout import OnnxModel  # noqa: F401
        import pymupdf  # noqa: F401
    except Exception as error:
        raise WorkerError(
            "engine",
            f"请用指定的 Python 安装 BabelDOC=={ENGINE_VERSION}。"
            "Windows 上若提示 DLL 加载失败，请安装 Microsoft Visual C++ 运行库。",
        ) from error


def selected_pages(spec, page_count):
    if not spec:
        return range(1, page_count + 1)
    pages = set()
    for part in spec.split(","):
        if not re.fullmatch(r"[1-9][0-9]{0,5}(?:-[1-9][0-9]{0,5})?", part):
            raise WorkerError("pages", "页码应使用 1,3-5 这样的格式。")
        ends = part.split("-")
        first, last = int(ends[0]), int(ends[-1])
        if not first <= last <= page_count:
            raise WorkerError("pages", f"所填页码超出此 PDF 的范围或区间无效。此文件共有 {page_count} 页。")
        pages.update(range(first, last + 1))
    return sorted(pages)


async def render(job, directory, pipe):
    import pymupdf
    from babeldoc.docvision.base_doclayout import DocLayoutModel
    from babeldoc.format.pdf.high_level import async_translate
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from babeldoc.translator.translator import BaseTranslator

    source = Path(job["input"])
    source_lang = job["source"]
    target_lang = job["target"]
    mode = job["mode"]
    layout = job["layout"]
    pages = job["pages"]
    if (source_lang not in LANGUAGES or target_lang not in LANGUAGES or source_lang == target_lang
            or mode not in {"mono", "dual", "both"} or layout not in {"side-by-side", "alternating"}):
        raise WorkerError("settings", "目标语言或 PDF 输出设置无效。")
    if not source.is_absolute() or not source.is_file():
        raise WorkerError("input", "PDF 附件在本机不可用。")

    try:
        with pymupdf.open(source) as document:
            if not document.is_pdf or not document.page_count:
                raise WorkerError("input", "无法打开此 PDF。")
            if document.needs_pass:
                raise WorkerError("input", "请先在本机保存 PDF 的解锁副本。")
            page_numbers = selected_pages(pages, document.page_count)
            if not any(document[number - 1].get_text().strip() for number in page_numbers):
                raise WorkerError("scan", "所选页没有可提取文字。请先为 PDF 添加 OCR 文字层。")
    except (pymupdf.FileDataError, pymupdf.EmptyFileError) as error:
        raise WorkerError("input", "无法读取此 PDF，文件可能已损坏。") from error

    bridge = TranslationBridge(pipe)

    class ChatGPTTranslator(BaseTranslator):
        name = "chatgpt-pdf"
        model = "ChatGPT"

        def do_llm_translate(self, text, rate_limit_params=None):
            return bridge.translate(text)

        def do_translate(self, text, rate_limit_params=None):
            target = LANGUAGES[self.lang_out]
            return bridge.translate(
                f"Translate the following scholarly passage into {target}. "
                "Preserve numbers, citations, tags and placeholders exactly. "
                "Return only the translation.\n\n"
                + json.dumps({"passage": text}, ensure_ascii=False)
            )

    try:
        model = DocLayoutModel.load_onnx()
    except (Exception, SystemExit) as error:
        raise WorkerError(
            "assets", "无法加载 BabelDOC 的本地版面模型。请联网运行 babeldoc --warmup 后重试。",
        ) from error

    output_dir = directory / "output"
    output_dir.mkdir()
    config = TranslationConfig(
        translator=ChatGPTTranslator(source_lang, target_lang, ignore_cache=True),
        input_file=source,
        lang_in=source_lang,
        lang_out=target_lang,
        doc_layout_model=model,
        pages=pages or None,
        output_dir=output_dir,
        working_dir=directory / "work",
        no_dual=mode == "mono",
        no_mono=mode == "dual",
        use_rich_pbar=False,
        qps=1,
        pool_max_workers=1,
        use_alternating_pages_dual=layout == "alternating",
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
        add_formula_placehold_hint=True,
        auto_extract_glossary=False,
        only_include_translated_page=bool(pages),
        report_interval=0.45,
    )

    result = None
    async for event in async_translate(config):
        event_type = event["type"]
        if event_type in {"progress_start", "progress_update", "progress_end"}:
            pipe.send("progress", stage=event["stage"], percent=event.get("overall_progress"))
        elif event_type == "finish":
            result = event["translate_result"]
            # Follow BabelDOC’s CLI and stop at the terminal event.
            break
        elif event_type == "error":
            detail = str(event["error"]).lower()
            if "scanned" in detail:
                raise WorkerError("scan", "BabelDOC 检测到扫描页。请先为 PDF 添加 OCR 文字层。")
            if any(word in detail for word in ("download", "font", "certificate", "connection")):
                raise WorkerError("assets", "排版所需资源读取失败。请联网运行 babeldoc --warmup 后重试。")
            raise WorkerError("render", "BabelDOC 无法完成此 PDF 的排版。")
    if bridge.failure:
        raise bridge.failure
    if not result or not bridge.count:
        raise WorkerError("render", "没有生成可输出的译文。请检查 PDF 的文字层或页码。")

    outputs = []
    for kind, filename in OUTPUT_FILES.items():
        if mode not in (kind, "both"):
            continue
        path = getattr(result, f"{kind}_pdf_path")
        if not path or not path.is_file():
            raise WorkerError("render", "排版引擎未生成要求的全部 PDF。")
        shutil.move(path, directory / filename)
        outputs.append(kind)
    return outputs


def run():
    # Keep library output away from the JSON-only channel even at the OS level.
    wire = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    pipe = Pipe(sys.stdin.buffer, wire)
    logging.disable(logging.CRITICAL)
    try:
        job = pipe.read()
        if job.get("type") not in {"probe", "render"}:
            raise WorkerError("pipe", "不支持的排版进程请求。")
        pipe.send("progress", stage="Preparing BabelDOC", percent=None)
        check_engine()
        if job["type"] == "probe":
            pipe.send("done", version=ENGINE_VERSION)
        else:
            outputs = asyncio.run(render(job, Path.cwd(), pipe))
            pipe.send("done", outputs=outputs)
        return 0
    except WorkerError as error:
        pipe.send("error", code=error.code, message=str(error))
    except SystemExit:
        pipe.send("error", code="assets", message="排版资源准备失败。请联网运行 babeldoc --warmup 后重试。")
    except Exception as error:
        pipe.send("error", code="render", message=f"排版进程失败（{type(error).__name__}）。")
    return 1


if __name__ == "__main__":
    sys.exit(run())
