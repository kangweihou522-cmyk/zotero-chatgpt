/* SPDX-License-Identifier: AGPL-3.0-only */
var ChatGPTPDFMain = (() => {
  "use strict";

  const PREF_PREFIX = "extensions.zotero-chatgpt-pdf.";
  const GENERATED_TITLE = "ChatGPT PDF · ";
  const LANGUAGES = {
    en: "英语", "zh-CN": "简体中文", "zh-TW": "繁體中文", ja: "日语",
    ko: "韩语", fr: "法语", de: "德语", es: "西班牙语", ru: "俄语",
  };
  const DEFAULTS = { python: "", source: "en", target: "zh-CN", mode: "dual", layout: "side-by-side" };
  const windows = new Set();
  const menuIDs = [];
  let auth;
  let renderer;
  let dialog;

  function pref(key) {
    return Zotero.Prefs.get(PREF_PREFIX + key, true);
  }

  function setPref(key, value) {
    Zotero.Prefs.set(PREF_PREFIX + key, value, true);
  }

  function loadSettings() {
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, pref(key) || fallback]));
  }

  function modelKey(accountId) {
    return "model." + accountId;
  }

  function getPDFs(win) {
    const result = new Map();
    const add = (item, includeGenerated) => {
      if (!item || item.deleted || !item.isPDFAttachment()) return;
      const title = item.getField("title") || item.attachmentFilename || "PDF";
      if (!includeGenerated && title.startsWith(GENERATED_TITLE)) return;
      result.set(item.id, { id: item.id, title, parentTitle: item.parentItem?.getField("title") || "" });
    };
    for (const item of win?.ZoteroPane?.getSelectedItems() || []) {
      if (item.deleted) continue;
      if (item.isAttachment()) add(item, true);
      else if (item.isRegularItem()) {
        for (const id of item.getAttachments()) add(Zotero.Items.get(id), false);
      }
    }
    return Array.from(result.values());
  }

  function assertWritable(source) {
    if (!source || source.deleted || !source.isPDFAttachment()) {
      throw new Error("原 PDF 已移走或删除。请重新选择附件。");
    }
    const library = Zotero.Libraries.get(source.libraryID);
    if (!library?.editable || !library.filesEditable || source.parentItem?.deleted) {
      throw new Error("此文献库当前无法添加 PDF 附件。");
    }
  }

  async function translate(id, settings, { signal, onProgress }) {
    const source = await Zotero.Items.getAsync(id);
    assertWritable(source);
    const input = await source.getFilePathAsync();
    if (!input) throw new Error("原 PDF 尚未保存在本机。请先在 Zotero 打开或下载附件。");
    const parentID = source.parentID || null;
    let saved = 0;
    try {
      return await renderer.render(settings.python, {
        input,
        source: settings.source,
        target: settings.target,
        pages: settings.pages,
        mode: settings.mode,
        layout: settings.layout,
      }, {
        model: settings.model,
        signal,
        onProgress,
        useOutput: async outputs => {
          const current = await Zotero.Items.getAsync(id);
          assertWritable(current);
          if ((current.parentID || null) !== parentID || await current.getFilePathAsync() !== input) {
            throw new Error("翻译期间原附件位置已变更。请重新选择附件。");
          }
          signal.throwIfAborted();
          onProgress({ stage: "Saving to Zotero", percent: 100 });
          const originalTitle = current.getField("title") || current.attachmentFilename;
          const stem = PathUtils.filename(input).replace(/\.pdf$/i, "").slice(0, 100);
          for (const { kind, path } of outputs) {
            const title = kind === "mono" ? "译文" : settings.layout === "alternating" ? "交替页双语" : "并排双语";
            const suffix = kind === "dual" && settings.layout === "alternating" ? "alternating" : kind;
            const pageLabel = settings.pages ? " · 第 " + settings.pages + " 页" : "";
            await Zotero.Attachments.importFromFile({
              file: path,
              libraryID: current.libraryID,
              ...(parentID ? { parentItemID: parentID } : { collections: current.getCollections() }),
              title: GENERATED_TITLE + title + "（" + LANGUAGES[settings.target] + "）" + pageLabel + " · " + originalTitle,
              fileBaseName: Zotero.File.getValidFileName(stem + ".chatgpt-" + settings.target + "-" + suffix),
              contentType: "application/pdf",
            });
            saved++;
          }
          return saved;
        },
      });
    } catch (error) {
      if (saved) {
        const partial = new Error("已保存 " + saved + " 个附件，其余保存失败。" + error.message);
        partial.saved = saved;
        throw partial;
      }
      throw error;
    }
  }

  function owner(event) {
    return event?.target?.ownerDocument?.defaultView || Zotero.getMainWindow();
  }

  function open(win, showSettings = false) {
    if (!win) return;
    if (dialog && !dialog.closed) {
      dialog.focus();
      return;
    }
    dialog = win.openDialog("chrome://zotero-chatgpt-pdf/content/dialog.xhtml", "zotero-chatgpt-pdf",
      "chrome,centerscreen,resizable,dialog=no", {
        items: getPDFs(win),
        showSettings,
        languages: LANGUAGES,
        settings: loadSettings(),
        saveSettings(settings) {
          for (const key of Object.keys(DEFAULTS)) setPref(key, settings[key]);
        },
        getModel: accountId => pref(modelKey(accountId)) || "",
        setModel: (accountId, model) => setPref(modelKey(accountId), model),
        getPages: ChatGPTPDFRenderer.getPages,
        auth,
        probe: renderer.probe,
        translate,
        launchURL: url => Zotero.launchURL(url),
      });
  }

  function addWindow(win) {
    if (!win || windows.has(win)) return;
    win.MozXULElement.insertFTLIfNeeded("zotero-chatgpt-pdf.ftl");
    windows.add(win);
  }

  function removeWindow(win) {
    if (!windows.delete(win)) return;
    for (const link of win.document?.querySelectorAll('link[href="zotero-chatgpt-pdf.ftl"]') || []) link.remove();
  }

  function start({ id, rootURI }) {
    auth = ChatGPTPDFAuth.create({ Zotero, Services, ChromeUtils, Cc, Ci, crypto, setTimeout, clearTimeout });
    renderer = ChatGPTPDFRenderer.create({ Zotero, ChromeUtils, IOUtils, PathUtils, auth, rootURI });
    for (const win of Zotero.getMainWindows()) addWindow(win);
    const translateMenu = {
      menuType: "menuitem",
      l10nID: "zotero-chatgpt-pdf-translate",
      onShowing: (event, context) => context.setEnabled(getPDFs(owner(event)).length > 0),
      onCommand: event => open(owner(event)),
    };
    for (const [menuID, target, menus] of [
      ["zotero-chatgpt-pdf-item", "main/library/item", [translateMenu]],
      ["zotero-chatgpt-pdf-tools", "main/menubar/tools", [{
        menuType: "submenu",
        l10nID: "zotero-chatgpt-pdf-menu",
        menus: [translateMenu, {
          menuType: "menuitem",
          l10nID: "zotero-chatgpt-pdf-settings",
          onCommand: event => open(owner(event), true),
        }],
      }]],
    ]) {
      const registered = Zotero.MenuManager.registerMenu({ menuID, pluginID: id, target, menus });
      if (!registered) throw new Error("Could not register Zotero ChatGPT PDF menu");
      menuIDs.push(registered);
    }
    Zotero.ChatGPTPDF = { open: () => open(Zotero.getMainWindow()) };
  }

  function stop() {
    dialog?.close();
    dialog = null;
    auth?.dispose();
    for (const id of menuIDs.splice(0)) Zotero.MenuManager.unregisterMenu(id);
    for (const win of windows) removeWindow(win);
    delete Zotero.ChatGPTPDF;
  }

  return { start, stop, addWindow, removeWindow };
})();
