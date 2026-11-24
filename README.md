# Zotero ChatGPT PDF

在 Zotero 中用 **ChatGPT 订阅**翻译论文 PDF。BabelDOC 在本机识别版面、图表和公式位置，并将译文重新排进 PDF。支持单篇和批量翻译、指定页码、仅译文、并排双语和交替页双语。默认从英语翻译成简体中文。

插件独立安装，可与 Zotero PDF2zh 同时使用。排版沿用 PDFMathTranslate-next 使用的 BabelDOC 引擎。 [Zotero PDF2zh](https://github.com/guaguastandup/zotero-pdf2zh) · [BabelDOC](https://github.com/funstory-ai/BabelDOC)

## 安装

需要 Zotero 10.0.x 桌面版和 64 位 Python 3.11–3.13。下面的命令使用 Python 3.12。ChatGPT 翻译使用官方订阅授权，需要符合条件的 Plus／Pro 账户，并使用账户可用的模型和额度。无需填写 API Key。 [官方授权说明](https://developers.openai.com/siwc/token-sharing-open-source)

1. 下载 [Zotero 插件 XPI](https://github.com/kangweihou522-cmyk/zotero-chatgpt/raw/refs/tags/v0.1.0/downloads/zotero-chatgpt-pdf-0.1.0.xpi)。在 Zotero 打开 **工具 → 插件**，从齿轮菜单选择 **从文件安装插件…**，选择 XPI，并按提示重启。
2. 为排版引擎创建 Python 环境。已安装 BabelDOC 0.7.1 的环境可以直接使用。

   **Windows PowerShell**

   ```powershell
   $rendererDir = Join-Path $env:LOCALAPPDATA "ZoteroChatGPTPDF\renderer"
   py -3.12 -m venv $rendererDir
   & "$rendererDir\Scripts\python.exe" -m pip install BabelDOC==0.7.1
   & "$rendererDir\Scripts\babeldoc.exe" --warmup
   (Join-Path $rendererDir "Scripts\python.exe")
   ```

   **macOS / Linux**

   ```sh
   renderer_dir="$PWD/zotero-chatgpt-renderer"
   python3.12 -m venv "$renderer_dir"
   "$renderer_dir/bin/python" -m pip install BabelDOC==0.7.1
   "$renderer_dir/bin/babeldoc" --warmup
   printf '%s\n' "$renderer_dir/bin/python"
   ```

   `--warmup` 可提前下载 BabelDOC 的版面模型和字体。安装依赖并准备资源后，Zotero 可直接启动排版进程。

3. 在 Zotero 打开 **工具 → ChatGPT PDF → ChatGPT 与排版设置…**。选中上一步打印路径对应的 Python 可执行文件，点击 **检测**。
4. 点击 **Continue with ChatGPT**，在 OpenAI 官方登录页完成授权，再从账户可用的模型中选择翻译模型。可在 [ChatGPT 用量设置](https://chatgpt.com/settings/usage)查看额度。

## 翻译和保存

- 在文献库选中一篇或多篇文献，也可直接选中 PDF 附件。右键选择 **用 ChatGPT 翻译 PDF…**，确认待处理列表。
- 页码留空时翻译全文。输入 `1,3-5` 时，输出只包含指定页，批量任务将同一页码范围应用到队列里的每份 PDF。
- **并排双语**在同一页左右显示原文与译文。**交替页双语**按原文页、译文页交替。选择 **双语对照与仅译文**可同时生成两份附件。
- 点 **开始翻译**后，队列逐份处理。成功的文件保存为同一文献下的新附件。原 PDF 为独立条目时，译文也会作为独立条目保存，并加入原附件所在的分类。停止时，已经保存的结果仍可打开。

开始翻译时，BabelDOC 提取的文字会发送给 OpenAI。原 PDF 文件、页面图像和新生成的 PDF 由本机处理。登录凭据由 Zotero 登录管理器保存。源 PDF 和已有附件会保留。

## 常见问题

| 情况 | 处理方式 |
| --- | --- |
| 该 PDF 没有文字层 | 先用 OCR 为扫描件添加可选中的文字，再翻译。 |
| 原附件只有云端副本 | 先用 Zotero 打开或下载 PDF，再开始翻译。 |
| 版面模型或字体下载失败 | 在同一个 Python 环境中重新运行 `babeldoc --warmup`。 |
| Windows 提示 DLL 加载失败 | 安装 [Microsoft Visual C++ 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)，再在插件中检测 Python。 |
| ChatGPT 额度或模型权限提示 | 检查订阅授权和账户可用模型。额度适用范围以 OpenAI 服务端结果为准。 |

复杂的多栏、表格和公式排版由 BabelDOC 处理，效果取决于原 PDF 的结构和字体。扫描件的识别需要先完成 OCR。本版提供文献库的 PDF 翻译入口。

## 构建与验证

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/build.py
```

生成的安装包和 SHA-256 校验文件放在 `dist/`。Zotero 10.0.8 实机测试已通过，覆盖 XPI 安装、模型读取、指定页翻译、两种双语版式和附件保存。测试使用模拟账户和模型响应。实际订阅登录和模型额度在用户本机验证。 [实机测试记录](https://github.com/kangweihou522-cmyk/zotero-chatgpt/actions/runs/45391565452)

本项目使用 AGPL-3.0。ChatGPT 授权模块来自同账户的 [Zotero Ollama Local AI](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai)，沿用随包提供的 MIT 许可。BabelDOC 由用户的 Python 独立安装。
