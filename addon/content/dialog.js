/* SPDX-License-Identifier: AGPL-3.0-only */
window.addEventListener("DOMContentLoaded", () => {
  "use strict";

  const $ = id => document.getElementById(id);
  const bridge = window.arguments?.[0];
  if (!bridge) {
    $("status").textContent = "请从 Zotero 的 ChatGPT PDF 菜单打开此窗口。";
    return;
  }

  const XHTML = "http://www.w3.org/1999/xhtml";
  const README = "https://github.com/kangweihou522-cmyk/zotero-chatgpt#安装";
  const USAGE = "https://chatgpt.com/settings/usage";
  const STAGES = {
    "Preparing BabelDOC": "准备本地排版引擎",
    "Parse PDF and Create Intermediate Representation": "解析 PDF",
    "DetectScannedFile": "检查文字层",
    "Parse Page Layout": "识别页面布局",
    "Parse Paragraphs": "提取段落",
    "Parse Formulas and Styles": "识别公式与文字样式",
    "Translate Paragraphs": "请求 ChatGPT 翻译",
    "Typesetting": "排版译文",
    "Generate PDF": "生成 PDF",
    "Saving to Zotero": "保存到 Zotero",
  };
  const preferences = ["python", "source", "target", "mode", "layout"];
  const entries = [];
  let active;
  let account = { connected: false, accounts: [], accountId: "" };

  function report(message, isError = false) {
    $("status").textContent = message;
    $("status").classList.toggle("error", isError);
  }

  function element(name) {
    return document.createElementNS(XHTML, name);
  }

  function option(value, label) {
    const node = element("option");
    node.value = value;
    node.textContent = label;
    return node;
  }

  function settings() {
    return Object.fromEntries(preferences.map(key => [key, $(key).value.trim()]));
  }

  function update() {
    const selected = entries.filter(entry => entry.checkbox.checked).length;
    $("selected-count").textContent = "已选 " + selected + " / " + entries.length;
    for (const key of [...preferences, "pages", "logout", "login", "add-account", "pick-python",
      "models", "model", "probe", "account"]) {
      $(key).disabled = Boolean(active);
    }
    for (const entry of entries) entry.checkbox.disabled = Boolean(active);
    if (!active) {
      $("logout").disabled = !account.connected;
      $("models").disabled = !account.connected;
      $("model").disabled = !account.connected;
      $("account").disabled = account.accounts.length < 2;
      $("probe").disabled = !$("python").value.trim();
      $("layout").disabled = $("mode").value === "mono";
    }
    $("add-account").hidden = !account.accounts.length;
    $("start").disabled = Boolean(active || !selected || !account.connected || !$("model").value || !$("python").value.trim());
    $("cancel").disabled = !active || active.signal.aborted;
  }

  function accountDisplay(status) {
    account = status;
    $("account").replaceChildren(...status.accounts.map(saved => option(saved.id, saved.label)));
    if (!status.accounts.length) $("account").append(option("", "尚未授权"));
    $("account").value = status.accountId;
    $("account-status").textContent = status.connected
      ? "已授权 · " + status.accountLabel
      : "请登录有资格使用订阅额度的 ChatGPT 账号并授权。";
    const model = status.connected && bridge.getModel(status.accountId);
    $("model").replaceChildren(option("", "读取可用模型后选择"));
    if (model) $("model").append(option(model, model));
    $("model").value = model || "";
    update();
  }

  async function listModels(signal) {
    const models = await bridge.auth.listModels({ signal });
    signal.throwIfAborted();
    if (!models.length) throw new Error("当前 ChatGPT 账户未返回可选模型。");
    const previous = $("model").value;
    $("model").replaceChildren(...models.map(model => option(model.id, model.name)));
    if (models.some(model => model.id === previous)) $("model").value = previous;
    bridge.setModel(account.accountId, $("model").value);
    report("已读取 " + models.length + " 个可选模型。");
  }

  async function task(action) {
    if (active) return;
    active = new AbortController();
    update();
    try {
      await action(active.signal);
    } catch (error) {
      report(active.signal.aborted || error.name === "AbortError" ? "已停止。" : error.message,
        !active.signal.aborted && error.name !== "AbortError");
    } finally {
      active = null;
      update();
    }
  }

  function setRow(entry, text, error = false) {
    entry.result.textContent = text;
    entry.result.classList.toggle("error", error);
  }

  function displayProgress({ stage, percent }, index, total) {
    const progress = $("progress");
    progress.hidden = false;
    if (Number.isFinite(percent)) progress.value = Math.max(0, Math.min(percent, 100));
    else progress.removeAttribute("value");
    report(index + " / " + total + " · " + (STAGES[stage] || "正在排版与翻译"));
  }

  function setQueue() {
    for (const item of bridge.items) {
      const row = element("div");
      row.className = "row";
      const label = element("label");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.addEventListener("change", update);
      const title = element("span");
      title.textContent = item.parentTitle && item.parentTitle !== item.title ? item.parentTitle + " · " + item.title : item.title;
      label.append(checkbox, title);
      const result = element("p");
      result.className = "row-result";
      row.append(label, result);
      $("items").append(row);
      entries.push({ ...item, checkbox, result });
    }
    $("empty").hidden = Boolean(entries.length);
  }

  for (const id of ["source", "target"]) {
    $(id).replaceChildren(...Object.entries(bridge.languages).map(([value, label]) => option(value, label)));
  }
  for (const key of preferences) {
    $(key).value = bridge.settings[key];
    $(key).addEventListener("change", () => {
      bridge.saveSettings(settings());
      if (key === "python") $("renderer-status").textContent = "需要 Python 3.11–3.13 和 BabelDOC 0.7.1。";
      update();
    });
  }
  $("python").addEventListener("input", update);
  $("model").addEventListener("change", () => {
    if (account.accountId) bridge.setModel(account.accountId, $("model").value);
    update();
  });

  $("pick-python").addEventListener("click", () => task(async signal => {
    const picker = Components.classes["@mozilla.org/filepicker;1"]
      .createInstance(Components.interfaces.nsIFilePicker);
    picker.init(window.browsingContext, "选择 Python 可执行文件", picker.modeOpen);
    const result = await new Promise(resolve => picker.open(resolve));
    signal.throwIfAborted();
    if (result !== picker.returnOK) return;
    $("python").value = picker.file.path;
    bridge.saveSettings(settings());
    $("renderer-status").textContent = "点击检测以检查选定的 Python。";
  }));
  $("probe").addEventListener("click", () => task(async signal => {
    $("renderer-status").textContent = "正在检测 BabelDOC…";
    try {
      const version = await bridge.probe($("python").value.trim(), signal);
      $("renderer-status").textContent = "BabelDOC " + version + " 已就绪。首次排版会读取或下载版面模型和字体。";
      report("本地排版引擎检测通过。");
    } catch (error) {
      $("renderer-status").textContent = "检测未完成。";
      throw error;
    }
  }));
  $("usage").addEventListener("click", () => bridge.launchURL(USAGE));
  $("help").addEventListener("click", () => bridge.launchURL(README));
  $("account").addEventListener("change", () => task(async signal => {
    await bridge.auth.selectAccount($("account").value);
    accountDisplay(await bridge.auth.status());
    if (account.connected) await listModels(signal);
  }));
  for (const id of ["login", "add-account"]) {
    $(id).addEventListener("click", () => task(async signal => {
      const status = await bridge.auth.login({ signal, newAccount: id === "add-account", onStatus: report });
      accountDisplay(status);
      await listModels(signal);
    }));
  }
  $("models").addEventListener("click", () => task(listModels));
  $("logout").addEventListener("click", () => task(async signal => {
    const result = await bridge.auth.logout({ signal });
    accountDisplay(result);
    report(result.message);
  }));
  $("cancel").addEventListener("click", () => {
    active?.abort();
    report("正在停止当前操作…");
    update();
  });
  $("start").addEventListener("click", () => task(async signal => {
    const options = settings();
    if (options.source === options.target) throw new Error("请选择不同的原文语言和目标语言。");
    options.pages = bridge.getPages($("pages").value);
    options.model = $("model").value;
    bridge.saveSettings(options);
    const queue = entries.filter(entry => entry.checkbox.checked);
    let succeeded = 0, failed = 0, saved = 0;
    for (const entry of queue) setRow(entry, "等待翻译");
    for (const [index, entry] of queue.entries()) {
      if (signal.aborted) break;
      setRow(entry, "正在翻译");
      displayProgress({}, index + 1, queue.length);
      try {
        const count = await bridge.translate(entry.id, options, {
          signal,
          onProgress: state => displayProgress(state, index + 1, queue.length),
        });
        succeeded++;
        saved += count;
        setRow(entry, "已保存 " + count + " 个 PDF 附件");
      } catch (error) {
        saved += error.saved || 0;
        if (signal.aborted && !error.saved) {
          setRow(entry, "已停止");
          break;
        }
        failed++;
        setRow(entry, error.message, true);
        // Authentication and quota errors also affect every remaining file.
        if (error.status === 401 || error.status === 403 || error.status === 429) break;
      }
    }
    for (const entry of queue) {
      if (entry.result.textContent === "等待翻译") setRow(entry, "未开始");
    }
    $("progress").hidden = true;
    const rest = queue.length - succeeded - failed;
    const summary = "成功 " + succeeded + "，失败 " + failed + "，未完成 " + rest + "。已保存 " + saved + " 个 PDF 附件。";
    report((signal.aborted ? "已停止。" : "") + summary, Boolean(failed));
  }));
  window.addEventListener("unload", () => active?.abort(), { once: true });

  setQueue();
  update();
  bridge.auth.status().then(status => {
    accountDisplay(status);
    $("settings").open = Boolean(bridge.showSettings || !status.connected || !$("model").value || !$("python").value);
  }).catch(error => report(error.message, true));
}, { once: true });
