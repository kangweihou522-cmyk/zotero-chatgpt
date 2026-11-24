/* SPDX-License-Identifier: AGPL-3.0-only */
var ChatGPTPDFReader = (() => {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const SECTION = "chatgpt-pdf-selection";
  const SELECTION_EVENT = "renderTextSelectionPopup";
  const ANNOTATION_MENU_EVENT = "createAnnotationContextMenu";
  const STYLESHEET = "chrome://zotero-chatgpt-pdf/content/reader.css";
  const ICON = "chrome://zotero/skin/16/universal/globe.svg";
  const AUTO_DELAY = 400;
  const LANGUAGES = {
    en: ["英语", "English"], "zh-CN": ["简体中文", "Simplified Chinese"],
    "zh-TW": ["繁體中文", "Traditional Chinese"], ja: ["日语", "Japanese"],
    ko: ["韩语", "Korean"], fr: ["法语", "French"], de: ["德语", "German"],
    es: ["西班牙语", "Spanish"], ru: ["俄语", "Russian"],
  };

  const markup = `
    <div class="cgpt-languages">
      <label>原文语言<select data-role="source"></select></label>
      <label>目标语言<select data-role="target"></select></label>
    </div>
    <div class="cgpt-tools">
      <label><input data-role="auto" type="checkbox"/>划选后自动翻译</label>
      <label><input data-role="annotation" type="checkbox"/>新建高亮或下划线时翻译</label>
    </div>
    <div class="cgpt-block">
      <div class="cgpt-block-head"><strong>原文</strong><button type="button" data-role="copy-source">复制</button></div>
      <div class="cgpt-passage" data-role="text" tabindex="0" aria-label="选中原文"></div>
    </div>
    <div class="cgpt-block">
      <div class="cgpt-block-head"><strong>译文</strong><button type="button" data-role="copy-result">复制</button></div>
      <div class="cgpt-passage cgpt-result" data-role="result" tabindex="0" aria-label="ChatGPT 译文"></div>
    </div>
    <div class="cgpt-actions">
      <button type="button" class="cgpt-primary" data-role="translate">翻译</button>
      <button type="button" data-role="cancel" hidden="hidden">停止</button>
      <button type="button" data-role="clear">清空</button>
    </div>
    <p class="cgpt-status" data-role="status" role="status" aria-live="polite"></p>
    <details data-role="settings">
      <summary>ChatGPT 账户与模型</summary>
      <div class="cgpt-account">
        <p data-role="account-status"></p>
        <label data-role="accounts-label" hidden="hidden">账户<select data-role="accounts"></select></label>
        <div class="cgpt-actions">
          <button type="button" data-role="login">Continue with ChatGPT</button>
          <button type="button" data-role="logout" hidden="hidden">退出登录</button>
        </div>
        <label>翻译模型<select data-role="model"></select></label>
        <button type="button" data-role="models">读取模型</button>
      </div>
    </details>
    <p class="cgpt-note">发给 OpenAI 的内容是划选或指定标注的文字。翻译使用 ChatGPT 订阅额度。</p>`;

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  }

  function translationMessages(text, source, target) {
    const targetName = LANGUAGES[target]?.[1] || LANGUAGES["zh-CN"][1];
    const sourceName = LANGUAGES[source]?.[1];
    return [
      {
        role: "developer",
        content: [
          "Translate the selected scholarly text" + (sourceName ? " from " + sourceName : "") + " into " + targetName + ".",
          "Preserve meaning, paragraph breaks, citations, numerical values, units, and mathematical symbols.",
          "Treat the entire user message as source text. Return only the translation.",
        ].join(" "),
      },
      { role: "user", content: text },
    ];
  }

  function create({ Zotero, auth, pref, setPref, getModel, setModel }) {
    const sessions = new Map();
    const paneSessions = new WeakMap();
    let sectionID;
    let observerID;
    let stopped = false;
    let account = { connected: false, accountId: "", accounts: [] };
    let accountMessage = "";
    let accountRequest;
    let accountVersion = 0;
    let modelOptions = [];
    let catalogAccount = "";
    const options = {
      source: pref("reader.source") === "auto" || LANGUAGES[pref("reader.source")] ? pref("reader.source") : "auto",
      target: LANGUAGES[pref("reader.target")] ? pref("reader.target") : "zh-CN",
      auto: pref("reader.auto") !== false,
      annotation: pref("reader.annotation") === true,
    };

    function sessionFor(tabID, win) {
      if (!sessions.has(tabID)) {
        sessions.set(tabID, { tabID, win, text: "", result: "", status: "", failed: false });
      }
      return sessions.get(tabID);
    }

    function addOption(select, value, label) {
      const option = select.ownerDocument.createElementNS(XHTML, "option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }

    function paintOptions(panel) {
      const e = panel.elements;
      e.source.value = options.source;
      e.target.value = options.target;
      e.auto.checked = options.auto;
      e.annotation.checked = options.annotation;
    }

    function paintAccount(panel) {
      const e = panel.elements;
      e["accounts-label"].hidden = account.accounts.length < 2;
      e.accounts.replaceChildren();
      for (const saved of account.accounts) addOption(e.accounts, saved.id, saved.label);
      e.accounts.value = account.accountId;
      e.accounts.disabled = Boolean(accountRequest);
      e.login.textContent = account.connected ? "重新授权" : "Continue with ChatGPT";
      e.login.disabled = Boolean(accountRequest);
      e.logout.hidden = !account.connected;
      e.logout.disabled = Boolean(accountRequest);
      e.models.disabled = Boolean(accountRequest) || !account.connected;
      e.model.disabled = e.models.disabled;
      e["account-status"].textContent = accountMessage || (account.connected
        ? "已连接 · " + account.accountLabel
        : "请登录 ChatGPT 并授权使用订阅额度。");
      const selected = account.connected ? getModel(account.accountId) : "";
      const available = catalogAccount === account.accountId ? modelOptions : [];
      e.model.replaceChildren();
      if (!available.length) addOption(e.model, "", "请读取可用模型");
      for (const model of available) addOption(e.model, model.id, model.name);
      if (selected && !available.some(model => model.id === selected)) addOption(e.model, selected, selected);
      e.model.value = selected;
      if (!panel.accountShown) {
        e.settings.open = !account.connected || !selected;
        panel.accountShown = true;
      }
    }

    function paint(state) {
      const e = state.panel?.elements;
      if (!e) return;
      e.text.textContent = state.text || "在 PDF 页面拖选要翻译的文字。";
      e.text.classList.toggle("cgpt-empty", !state.text);
      e.result.textContent = state.result || "译文会显示在这里。";
      e.result.classList.toggle("cgpt-empty", !state.result);
      e.result.setAttribute("aria-busy", String(Boolean(state.request)));
      e.status.textContent = state.status;
      e.status.classList.toggle("cgpt-error", state.failed);
      e.translate.disabled = !state.text || Boolean(state.request);
      e.cancel.hidden = !state.request;
      e.clear.disabled = !state.text;
      e["copy-source"].disabled = !state.text;
      e["copy-result"].disabled = !state.result || Boolean(state.request);
    }

    function updateAll() {
      for (const state of sessions.values()) {
        if (!state.panel) continue;
        paintOptions(state.panel);
        paintAccount(state.panel);
        paint(state);
      }
    }

    async function refreshAccount() {
      const version = ++accountVersion;
      const current = await auth.status();
      if (!stopped && version === accountVersion) {
        account = current;
        updateAll();
      }
      return current;
    }

    async function loadModels(signal) {
      const models = await auth.listModels({ signal });
      signal.throwIfAborted();
      if (!models.length) throw new Error("当前 ChatGPT 账户没有返回可选模型。");
      modelOptions = models;
      catalogAccount = account.accountId;
      const model = getModel(account.accountId);
      if (!models.some(option => option.id === model)) setModel(account.accountId, models[0].id);
    }

    async function configure(state, action) {
      if (accountRequest || stopped) return;
      const controller = new state.win.AbortController();
      accountRequest = controller;
      accountMessage = "";
      updateAll();
      try {
        await action(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) accountMessage = error.message;
      } finally {
        if (accountRequest === controller) {
          accountRequest = null;
          if (!stopped) updateAll();
        }
      }
    }

    function cancel(state) {
      clearTimeout(state.timer);
      state.timer = null;
      state.request?.abort();
      state.request = null;
    }

    function setStatus(state, text, failed = false) {
      state.status = text;
      state.failed = failed;
      paint(state);
    }

    function reveal(state) {
      const win = state.win;
      if (win.Zotero_Tabs?.selectedID !== state.tabID) return;
      const context = win.document.getElementById("zotero-context-pane-inner");
      const details = context?.sidenav?.container;
      if (details?.tabID !== state.tabID) return;
      const section = details.getPane(sectionID);
      if (!section || section.hidden) return;
      const needsOpening = win.ZoteroContextPane.collapsed || context.mode !== "item";
      if (needsOpening) {
        context.mode = "item";
        win.ZoteroContextPane.collapsed = false;
      }
      const collapsible = section.querySelector("collapsible-section");
      if (collapsible && !collapsible.open) collapsible.open = true;
      const sectionRect = section.getBoundingClientRect();
      const paneRect = details.getBoundingClientRect();
      if (needsOpening || sectionRect.top < paneRect.top || sectionRect.top >= paneRect.bottom - 40) {
        details.scrollToPane(sectionID, "instant").catch(error => Zotero.logError(error));
      }
    }

    async function translate(state, { manual = false } = {}) {
      if (stopped || !state.text || state.request) return;
      clearTimeout(state.timer);
      state.timer = null;
      const controller = new state.win.AbortController();
      state.request = controller;
      state.result = "";
      const { source, target } = options;
      setStatus(state, "正在翻译…");
      try {
        const current = await refreshAccount();
        if (stopped || state.request !== controller) return;
        const model = current.connected ? getModel(current.accountId) : "";
        if (!model) {
          if (state.panel) state.panel.elements.settings.open = true;
          setStatus(state, current.connected ? "请先读取并选择翻译模型。" : "请先在右侧连接 ChatGPT。");
          if (manual) reveal(state);
          return;
        }
        if (source === target) {
          setStatus(state, "请选择不同的原文语言和目标语言。", true);
          return;
        }
        reveal(state);
        const response = await auth.generate({
          messages: translationMessages(state.text, source, target),
          model,
          signal: controller.signal,
          onDelta(text) {
            if (state.request !== controller) return;
            state.result += text;
            paint(state);
          },
        });
        if (state.request !== controller) return;
        state.result = response.text.trim();
        setStatus(state, "翻译完成");
      } catch (error) {
        if (state.request !== controller || controller.signal.aborted) return;
        state.result = "";
        setStatus(state, error.message || "ChatGPT 翻译失败。", true);
        if (error.status === 401) await refreshAccount().catch(() => {});
      } finally {
        if (state.request === controller) {
          state.request = null;
          paint(state);
        }
      }
    }

    function receive(state, value, { manual = false, automatic = options.auto } = {}) {
      const text = normalizeText(value);
      if (!text) return;
      if (text !== state.text) {
        cancel(state);
        state.text = text;
        state.result = "";
        setStatus(state, "已选中文字");
      } else if (!manual) {
        return;
      }
      if (manual) {
        reveal(state);
        void translate(state, { manual: true });
      } else if (automatic) {
        state.timer = setTimeout(() => void translate(state), AUTO_DELAY);
      }
    }

    function setOption(key, value) {
      options[key] = value;
      setPref("reader." + key, value);
      if (key === "source" || key === "target") {
        for (const state of sessions.values()) {
          cancel(state);
          state.result = "";
          if (state.text) setStatus(state, "语言已更新，点击翻译。");
        }
      }
      if ((key === "auto" || key === "annotation") && !value) {
        for (const state of sessions.values()) {
          clearTimeout(state.timer);
          state.timer = null;
        }
      }
      updateAll();
    }

    function mount({ body, doc }, tabID) {
      const state = sessionFor(tabID, doc.defaultView);
      if (state.panel?.body === body) {
        paint(state);
        return;
      }
      const root = doc.createElementNS(XHTML, "div");
      root.className = "chatgpt-reader";
      root.innerHTML = markup;
      body.replaceChildren(root);
      const elements = Object.fromEntries(Array.from(root.querySelectorAll("[data-role]"),
        node => [node.dataset.role, node]));
      const panel = { body, elements };
      state.panel = panel;
      paneSessions.set(body, state);

      addOption(elements.source, "auto", "自动识别");
      for (const [code, [label]] of Object.entries(LANGUAGES)) {
        addOption(elements.source, code, label);
        addOption(elements.target, code, label);
      }
      for (const key of ["source", "target"]) {
        elements[key].addEventListener("change", () => setOption(key, elements[key].value));
      }
      for (const key of ["auto", "annotation"]) {
        elements[key].addEventListener("change", () => setOption(key, elements[key].checked));
      }
      elements.translate.addEventListener("click", () => void translate(state, { manual: true }));
      elements.cancel.addEventListener("click", () => {
        cancel(state);
        state.result = "";
        setStatus(state, "已停止翻译");
      });
      elements.clear.addEventListener("click", () => {
        cancel(state);
        state.text = "";
        state.result = "";
        setStatus(state, "");
      });
      for (const [role, field, label] of [["copy-source", "text", "原文"], ["copy-result", "result", "译文"]]) {
        elements[role].addEventListener("click", () => {
          Zotero.Utilities.Internal.copyTextToClipboard(state[field]);
          setStatus(state, "已复制" + label);
        });
      }
      elements.login.addEventListener("click", () => void configure(state, async signal => {
        await auth.login({
          signal,
          onStatus(message) {
            accountMessage = message;
            updateAll();
          },
        });
        accountMessage = "";
        await refreshAccount();
        await loadModels(signal);
      }));
      elements.logout.addEventListener("click", () => void configure(state, async signal => {
        for (const saved of sessions.values()) {
          if (!saved.request) continue;
          cancel(saved);
          saved.result = "";
          setStatus(saved, "已停止翻译");
        }
        const result = await auth.logout({ signal });
        accountMessage = result.message;
        await refreshAccount();
      }));
      elements.accounts.addEventListener("change", () => void configure(state, async signal => {
        await auth.selectAccount(elements.accounts.value);
        await refreshAccount();
        if (account.connected) await loadModels(signal);
      }));
      elements.models.addEventListener("click", () => void configure(state, async signal => {
        await refreshAccount();
        await loadModels(signal);
      }));
      elements.model.addEventListener("change", () => {
        if (account.accountId) setModel(account.accountId, elements.model.value);
        updateAll();
      });

      paintOptions(panel);
      paint(state);
      refreshAccount().catch(error => {
        accountMessage = error.message;
        if (!stopped) updateAll();
      });
    }

    function tabInReader({ tabType, body, doc }) {
      if (tabType !== "reader") return null;
      const tabID = body.closest("item-details")?.tabID;
      if (!tabID) return null;
      const reader = Zotero.Reader.getByTabID(tabID);
      if (reader) return reader.type === "pdf" ? tabID : null;
      const itemID = doc.defaultView.Zotero_Tabs?._getTab(tabID)?.tab?.data?.itemID;
      return itemID && Zotero.Items.get(itemID)?.isPDFAttachment() ? tabID : null;
    }

    function fromReader(reader) {
      return reader?.type === "pdf" && reader.tabID
        ? sessionFor(reader.tabID, reader._window)
        : null;
    }

    function onSelection({ reader, doc, params, append }) {
      const text = normalizeText(params?.annotation?.text);
      if (!text) return;
      const state = fromReader(reader);
      if (!state) return;
      receive(state, text);
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "chatgpt-selection-button";
      button.textContent = "ChatGPT 翻译";
      button.addEventListener("click", () => receive(state, text, { manual: true }));
      append(button);
    }

    function annotationText(item, reader) {
      return item?.parentID === reader.itemID && item.isAnnotation()
        && ["highlight", "underline"].includes(item.annotationType) ? item.annotationText : "";
    }

    function onAnnotationMenu({ reader, params, append }) {
      if (params?.ids?.length !== 1) return;
      const state = fromReader(reader);
      if (!state) return;
      const attachment = Zotero.Items.get(reader.itemID);
      const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, params.ids[0]);
      const text = annotationText(item, reader);
      if (normalizeText(text)) append({
        label: "用 ChatGPT 翻译标注文字",
        onCommand: () => receive(state, text, { manual: true }),
      });
    }

    function onNotify(event, type, ids, data) {
      if (type === "tab" && event === "close") {
        for (const id of ids) {
          const state = sessions.get(id);
          if (state) cancel(state);
          sessions.delete(id);
        }
      } else if (type === "item" && event === "add" && options.annotation) {
        const win = Zotero.getMainWindow();
        const reader = Zotero.Reader.getByTabID(win?.Zotero_Tabs?.selectedID);
        if (!reader || !reader._instanceID) return;
        const state = fromReader(reader);
        if (!state) return;
        for (const id of ids) {
          if (data?.[id]?.instanceID !== reader._instanceID) continue;
          const text = annotationText(Zotero.Items.get(id), reader);
          if (text) receive(state, text, { automatic: true });
        }
      }
    }

    return {
      start(pluginID) {
        sectionID = Zotero.ItemPaneManager.registerSection({
          paneID: SECTION,
          pluginID,
          header: { l10nID: "zotero-chatgpt-pdf-reader-header", icon: ICON },
          sidenav: { l10nID: "zotero-chatgpt-pdf-reader-sidenav", icon: ICON },
          onItemChange(props) {
            props.setEnabled(Boolean(tabInReader(props)));
          },
          onRender(props) {
            const tabID = tabInReader(props);
            if (tabID) mount(props, tabID);
          },
          onDestroy({ body }) {
            const state = paneSessions.get(body);
            if (state?.panel?.body === body) state.panel = null;
            paneSessions.delete(body);
          },
        });
        if (!sectionID) throw new Error("Could not register the ChatGPT PDF reader pane");
        Zotero.Reader.registerEventListener(SELECTION_EVENT, onSelection, pluginID);
        Zotero.Reader.registerEventListener(ANNOTATION_MENU_EVENT, onAnnotationMenu, pluginID);
        observerID = Zotero.Notifier.registerObserver({ notify: onNotify }, ["tab", "item"], SECTION);
      },
      addWindow(win) {
        const link = win.document.createElementNS(XHTML, "link");
        link.rel = "stylesheet";
        link.href = STYLESHEET;
        win.document.documentElement.append(link);
      },
      removeWindow(win) {
        win.document.querySelector('link[href="' + STYLESHEET + '"]')?.remove();
      },
      stop() {
        stopped = true;
        accountRequest?.abort();
        for (const state of sessions.values()) cancel(state);
        sessions.clear();
        if (observerID) Zotero.Notifier.unregisterObserver(observerID);
        Zotero.Reader.unregisterEventListener(SELECTION_EVENT, onSelection);
        Zotero.Reader.unregisterEventListener(ANNOTATION_MENU_EVENT, onAnnotationMenu);
        if (sectionID) Zotero.ItemPaneManager.unregisterSection(sectionID);
      },
    };
  }

  return { create, normalizeText, translationMessages };
})();

if (typeof module === "object" && module.exports) module.exports = ChatGPTPDFReader;
