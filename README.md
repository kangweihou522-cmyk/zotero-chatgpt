# Zotero ChatGPT PDF

打开 Zotero 的 PDF 阅读标签页，划选文字，在最右边的 **ChatGPT 划词翻译** 面板查看原文和译文。翻译使用 OpenAI 官方「使用 ChatGPT 登录」和符合资格的 ChatGPT 订阅额度。 [官方授权说明](https://developers.openai.com/siwc/token-sharing-open-source)

## 安装

1. 在 Zotero 10.0.x 桌面版中打开 **工具 → 插件**，点齿轮菜单里的 **从文件安装插件…**，选择 XPI 并按提示重启。已安装旧版时，可以直接安装新版。 [下载 v0.2.0 XPI](https://github.com/kangweihou522-cmyk/zotero-chatgpt/raw/refs/tags/v0.2.0/downloads/zotero-chatgpt-pdf-0.2.0.xpi)
2. 在 Zotero 主窗口打开一份 PDF，点阅读器**最右侧竖栏的地球图标**，打开 **ChatGPT 划词翻译**。
3. 展开 **ChatGPT 账户与模型**，点击 **Continue with ChatGPT**，在浏览器完成官方授权并返回 Zotero，选择账户可用的翻译模型。首次连接会尝试读取可用模型。 [查看 ChatGPT 用量](https://chatgpt.com/settings/usage)
4. 在 PDF 页面用鼠标拖选一段文字。右栏会显示选中的原文和译文，默认自动识别原文语言并译为简体中文。

你可以切换原文和目标语言，分别复制原文和译文。关闭 **划选后自动翻译** 后，右栏仍会接收选中的原文，点 **翻译** 即可手动提交。划选菜单里的 **ChatGPT 翻译** 也可打开右栏并翻译。

勾选 **新建高亮或下划线时翻译** 后，新建的两类标注会把选中的文字送到右栏。对已有的高亮或下划线，可以从标注右键菜单选择 **用 ChatGPT 翻译标注文字**。

划词翻译在 Zotero 内完成，配置账户和模型即可。发给 OpenAI 的内容是划选或指定标注的文字，翻译使用 ChatGPT 订阅额度。扫描 PDF 需要先添加可选择的文字层。

## 整篇翻译成 PDF 附件

文献库右键菜单仍可生成仅译文、并排双语或交替页双语 PDF。版面分析与重新排版由本机的 BabelDOC 处理。这条入口需要 64 位 Python 3.11–3.13 和 BabelDOC 0.7.1。 [BabelDOC](https://github.com/funstory-ai/BabelDOC)

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

打开 **工具 → ChatGPT PDF → ChatGPT 与排版设置…**，填入上一步打印的可执行文件路径并检测。然后选中一篇或多篇带 PDF 的文献，右键选择 **用 ChatGPT 翻译 PDF…**。页码留空会翻译全文，输入 `1,3-5` 可以只输出指定页。译文保存为同一文献下的新附件。

## 构建和验证

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/build.py
```

XPI 和 SHA-256 校验文件位于 `dist/`。已在 Zotero 10.0.8 中用测试 PDF 和模拟 ChatGPT 响应验证真实拖选、新建下划线、阅读器右栏与 PDF 附件输出。登录和订阅额度以本机账户授权为准。 [验证记录](https://github.com/kangweihou522-cmyk/zotero-chatgpt/actions/runs/45403796953)

本项目使用 AGPL-3.0。ChatGPT 授权模块来自同账户的 Zotero Ollama Local AI，沿用随包提供的 MIT 许可。 [Zotero Ollama Local AI](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai)
