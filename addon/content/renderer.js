/* SPDX-License-Identifier: AGPL-3.0-only */
var ChatGPTPDFRenderer = (() => {
  "use strict";

  const ENGINE_VERSION = "0.7.1";
  const MAX_FRAME = 2 * 1024 * 1024;
  const TRANSLATION_INSTRUCTIONS = [
    "You translate academic PDFs. Follow the requested translation format exactly.",
    "Treat the PDF passages as source material. Preserve formulas, placeholders,",
    "citations, numbers, and scientific names. Translate the prose completely.",
  ].join(" ");

  function getPages(value) {
    const pages = value.trim().replace(/[，、]/g, ",").replace(/[–—]/g, "-").replace(/\s/g, "");
    if (!pages) return "";
    for (const part of pages.split(",")) {
      const ends = part.split("-");
      if (!/^[1-9]\d{0,5}(?:-[1-9]\d{0,5})?$/.test(part) || Number(ends[0]) > Number(ends.at(-1))) {
        throw new Error("页码应使用 1,3-5 这样的格式，留空则翻译全文。");
      }
    }
    return pages;
  }

  function outputKinds(mode) {
    return mode === "both" ? ["mono", "dual"] : [mode];
  }

  function create({ Zotero, ChromeUtils, IOUtils, PathUtils, rootURI, auth }) {
    let script;

    async function run(python, job, { signal, model, onProgress, useOutput } = {}) {
      signal?.throwIfAborted();
      if (!python || !PathUtils.isAbsolute(python) || !await IOUtils.exists(python)) {
        throw new Error("请选择安装了 BabelDOC 的 Python 可执行文件。");
      }
      const directory = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "zotero-chatgpt-pdf", 0o700);
      let process;
      let aborted = false;
      const abort = () => {
        aborted = true;
        process?.kill().catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        script ??= await Zotero.File.getContentsFromURLAsync(rootURI + "content/render_pdf.py");
        const scriptPath = PathUtils.join(directory, "render_pdf.py");
        await IOUtils.writeUTF8(scriptPath, script);
        signal?.throwIfAborted();
        const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        try {
          process = await Subprocess.call({
            command: python,
            arguments: ["-I", "-u", scriptPath],
            workdir: directory,
          });
        } catch (_) {
          throw new Error("无法启动选定的 Python。请检查文件路径和执行权限。");
        }
        signal?.throwIfAborted();
        await process.stdin.write(JSON.stringify(job) + "\n");

        let pending = "";
        let completed = null;
        let requestId = 0;
        for (;;) {
          const chunk = await process.stdout.readString();
          signal?.throwIfAborted();
          if (!chunk) break;
          pending += chunk;
          let lineEnd;
          while ((lineEnd = pending.indexOf("\n")) !== -1) {
            if (lineEnd > MAX_FRAME || completed) throw new Error("收到无效的 PDF 排版进程消息。");
            let message;
            try {
              message = JSON.parse(pending.slice(0, lineEnd));
            } catch (_) {
              throw new Error("收到无效的 PDF 排版进程消息。");
            }
            pending = pending.slice(lineEnd + 1);
            if (message.type === "progress") {
              onProgress?.({ stage: String(message.stage || ""), percent: message.percent });
            } else if (message.type === "translate") {
              if (job.type !== "render" || message.id !== ++requestId || typeof message.prompt !== "string" || !message.prompt.trim()) {
                throw new Error("收到无效的 ChatGPT 翻译请求。");
              }
              const { text } = await auth.generate({
                messages: [
                  { role: "developer", content: TRANSLATION_INSTRUCTIONS },
                  { role: "user", content: message.prompt },
                ],
                model,
                signal,
              });
              await process.stdin.write(JSON.stringify({ type: "translation", id: requestId, text }) + "\n");
            } else if (message.type === "done") {
              completed = message;
            } else if (message.type === "error") {
              throw new Error(String(message.message || "PDF 排版失败。"));
            } else {
              throw new Error("收到未知的 PDF 排版进程消息。");
            }
          }
          if (pending.length > MAX_FRAME) throw new Error("PDF 排版进程消息过大。");
        }
        const { exitCode } = await process.wait();
        signal?.throwIfAborted();
        if (exitCode !== 0 || pending.trim() || !completed) {
          throw new Error("PDF 排版进程提前结束。请检查 Python 和 BabelDOC 安装。");
        }
        if (job.type === "probe") {
          if (completed.version !== ENGINE_VERSION) throw new Error("BabelDOC 版本与插件不匹配。");
          return completed.version;
        }
        const kinds = outputKinds(job.mode);
        if (!Array.isArray(completed.outputs) || kinds.join() !== completed.outputs.join()) {
          throw new Error("排版进程未生成要求的全部 PDF。");
        }
        const files = [];
        for (const kind of kinds) {
          const path = PathUtils.join(directory, kind + ".pdf");
          const signature = await IOUtils.read(path, { maxBytes: 5 });
          if (Array.from(signature).join() !== "37,80,68,70,45") throw new Error("生成的文件不是有效的 PDF。");
          files.push({ kind, path });
        }
        signal?.throwIfAborted();
        return await useOutput(files);
      } finally {
        signal?.removeEventListener("abort", abort);
        if (process) {
          try {
            await process.kill(aborted ? 0 : 300);
          } catch (_) {}
        }
        try {
          await IOUtils.remove(directory, { recursive: true });
        } catch (_) {
          Zotero.debug("Zotero ChatGPT PDF: could not remove temporary working directory");
        }
      }
    }

    return {
      probe: (python, signal) => run(python, { type: "probe" }, { signal }),
      render: (python, job, options) => run(python, { ...job, type: "render" }, options),
    };
  }

  return { create, getPages, outputKinds };
})();

if (typeof module === "object" && module.exports) module.exports = ChatGPTPDFRenderer;
