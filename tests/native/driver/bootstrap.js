/* SPDX-License-Identifier: AGPL-3.0-only */
/* This driver runs only in the disposable profile prepared by run.sh. */
var finished = false;
var report = { success: false, requests: 0, readerRequests: 0 };
var addonID = "chatgpt-pdf@zotero.community";

function install() {}
function shutdown() {}

function startup() {
  run().then(() => finish(), error => finish(error));
  setTimeout(() => finish(new Error("Native test exceeded its deadline")), 210000);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(checkResult, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await checkResult();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for " + description);
}

function profileFile(name) {
  const file = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
  file.append(name);
  return file;
}

async function finish(error) {
  if (finished) return;
  finished = true;
  report.success = !error;
  if (error) report.error = String(error) + "\n" + String(error.stack || "");
  await IOUtils.writeUTF8(profileFile("result.json").path, JSON.stringify(report, null, 2));
  Services.startup.quit(Services.startup.eForceQuit);
}

function mockChatGPT() {
  const original = Zotero.HTTP.request;
  Zotero.HTTP.request = async function (method, url, options = {}) {
    if (url === "https://api.openai.com/v1/models") {
      check(options.headers.Authorization === "Bearer native-test-access", "Model catalog did not use the subscription session");
      return { status: 200, responseText: JSON.stringify({
        models: [{ slug: "native-test", display_name: "Native test", visibility: "list" }],
      }) };
    }
    if (url !== "https://api.openai.com/v1/responses") return original.apply(this, arguments);

    check(method === "POST" && options.headers.Authorization === "Bearer native-test-access", "Responses request not authenticated");
    const body = JSON.parse(options.body);
    check(body.model === "native-test" && body.store === false && body.stream === true, "Invalid Responses request");
    const prompt = body.input[0].content;
    const readerRequest = body.instructions.startsWith("Translate the selected scholarly text");
    if (readerRequest) {
      check(body.input.length === 1 && body.input[0].role === "user", "Reader passed unexpected content to ChatGPT");
      check(body.instructions.includes("Simplified Chinese"), "Wrong target language for PDF selection");
      const passages = new Map([
        ["Photosynthesis converts light energy into chemical energy.", "光合作用将光能转化为化学能。"],
        ["Text from a new underline.", "来自新下划线的文字。"],
      ]);
      report.lastSelectedText = prompt;
      check(passages.has(prompt), "ChatGPT received unexpected selected text: " + prompt);
      report.readerRequests++;
      return streamedText(passages.get(prompt), body.model);
    }
    check(!prompt.includes("MARS SURFACE SAMPLE"), "PDF text from an unselected page was transmitted");
    const translate = source => source.replace(
      /Photosynthesis converts light energy into chemical energy\./gi,
      "光合作用将光能转化为化学能。"
    );
    const boundary = "## Here is the input:";
    let translated;
    if (prompt.includes(boundary)) {
      const paragraphs = JSON.parse(prompt.split(boundary).at(-1).trim());
      translated = JSON.stringify(paragraphs.map(({ id, input }) => ({ id, output: translate(input) })));
    } else {
      const start = prompt.lastIndexOf('{"passage":');
      translated = translate(start < 0 ? prompt : JSON.parse(prompt.slice(start)).passage);
    }
    report.requests++;
    return streamedText(translated, body.model);
  };
}

function streamedText(text, model) {
  const events = [
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { status: "completed", model } },
  ];
  return { status: 200, responseText: events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("") };
}

function sendPDFDrag(view, pdfWindow, pageIndex) {
  const { chars } = view._pdfPages[pageIndex];
  const first = chars[0].rect;
  const last = chars.at(-1).rect;
  const pdfPage = pdfWindow.PDFViewerApplication.pdfViewer.getPageView(pageIndex);
  const bounds = pdfPage.div.getBoundingClientRect();
  const project = (x, y) => {
    const [left, top] = pdfPage.viewport.convertToViewportPoint(x, y);
    return [bounds.left + left, bounds.top + top];
  };
  const [x1, y1] = project(first[0] - 1, (first[1] + first[3]) / 2);
  const [x2, y2] = project(last[2] + 1, (last[1] + last[3]) / 2);
  const utils = pdfWindow.windowUtils;
  utils.sendMouseEvent("mousedown", x1, y1, 0, 1, 0);
  utils.sendMouseEvent("mousemove", (x1 + x2) / 2, (y1 + y2) / 2, 0, 0, 0);
  utils.sendMouseEvent("mousemove", x2, y2, 0, 0, 0);
  utils.sendMouseEvent("mouseup", x2, y2, 0, 1, 0);
  return [x1, y1, x2, y2];
}

async function saveReaderScreenshot(win) {
  try {
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = win.innerWidth;
    canvas.height = win.innerHeight;
    canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(profileFile("reader-translation.png").path, new Uint8Array(await blob.arrayBuffer()));
  } catch (error) {
    Zotero.debug("Could not capture the PDF reader screenshot: " + error.message);
  }
}

async function verifyReader(original, prefix) {
  report.stage = "open-pdf-reader";
  check(!Zotero.Prefs.get(prefix + "python", true), "Reader test requires a profile without a Python path");
  const win = Zotero.getMainWindow();
  win.resizeTo(1360, 850);
  const reader = await Zotero.Reader.open(original.id, { pageIndex: 1 });
  await reader._initPromise;
  const rail = win.document.getElementById("zotero-context-pane-sidenav");
  const button = await waitFor(() => {
    const current = rail.querySelector('[data-l10n-id="zotero-chatgpt-pdf-reader-sidenav"]');
    return current && !current.closest(".pin-wrapper").hidden && current;
  }, "ChatGPT icon in the rightmost navigation bar");
  button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
  const sidebar = await waitFor(() => {
    const current = win.document.getElementById(reader.tabID + "-context")?.querySelector(".chatgpt-reader");
    report.readerControls = current?.querySelectorAll("[data-role]").length;
    return current?.querySelector('[data-role="target"]')?.value === "zh-CN" && current;
  }, "ChatGPT translation controls under the PDF reader context");
  const role = name => sidebar.querySelector('[data-role="' + name + '"]');
  check(sidebar.closest("#zotero-context-pane-inner"), "Translation pane is outside the native right sidebar");
  check(role("auto").checked && role("target").value === "zh-CN", "Unexpected reader defaults");
  await waitFor(() => !role("models").disabled && role("account-status").textContent.includes("已连接"),
    "ChatGPT session inside the reader");
  role("models").click();
  await waitFor(() => role("model").value === "native-test", "ChatGPT model in the right pane");

  report.stage = "drag-select-text";
  const view = reader._internalReader._primaryView;
  const pdfWindow = view._iframeWindow;
  const pageIndex = 1;
  await waitFor(() => view._pdfPages[pageIndex]?.chars?.length
    && pdfWindow.PDFViewerApplication.pdfViewer.getPageView(pageIndex)?.div.getBoundingClientRect().height,
    "text geometry of the opened PDF page");
  report.drag = sendPDFDrag(view, pdfWindow, pageIndex);
  await waitFor(() => {
    report.readerStatus = role("status").textContent;
    report.readerSource = role("text").textContent;
    return role("result").textContent === "光合作用将光能转化为化学能。" && report.readerStatus === "翻译完成";
  }, "drag-selected text and its ChatGPT translation on the right");
  check(report.readerSource === "Photosynthesis converts light energy into chemical energy."
    && report.readerRequests === 1, "Reader translated something beyond the selection");
  report.readerSidebar = true;
  await saveReaderScreenshot(win);

  report.stage = "underline-translation";
  role("annotation").checked = true;
  role("annotation").dispatchEvent(new win.Event("change"));
  reader._internalReader._annotationManager._skipAnnotationSavingDebounce = true;
  reader._internalReader._annotationManager.addAnnotation(Components.utils.cloneInto({
    type: "underline", text: "Text from a new underline.", color: "#ffd400",
    position: { pageIndex: 1, rects: [[65, 688, 186, 700]] }, sortIndex: "00001|003305|00000",
  }, reader._iframeWindow));
  await waitFor(() => role("result").textContent === "来自新下划线的文字。"
    && role("status").textContent === "翻译完成", "new underline translation");
  check(report.readerRequests === 2, "Unexpected number of reader requests");
  win.Zotero_Tabs.close(reader.tabID);
}

async function run() {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  report.zotero = Zotero.version;
  check(Zotero.version === "10.0.8", "Unexpected Zotero version");
  const prefix = "extensions.zotero-chatgpt-pdf.";
  Zotero.Prefs.set(prefix + "chatgpt.activeClient", "native-test-client", true);
  const account = Components.classes["@mozilla.org/login-manager/loginInfo;1"]
    .createInstance(Components.interfaces.nsILoginInfo);
  account.init("chrome://zotero-chatgpt-pdf", null, "ChatGPT subscription authorization", "native-test-client",
    JSON.stringify({
      client_id: "native-test-client",
      issuer: "https://auth.openai.com",
      subject: "native-test-subject",
      access_token: "native-test-access",
      refresh_token: "native-test-refresh",
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
      expires_at: Date.now() + 86400000,
    }), "", "");
  await Services.logins.addLoginAsync(account);
  mockChatGPT();

  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const installation = await AddonManager.getInstallForFile(profileFile("plugin.xpi"));
  check(installation?.addon?.id === addonID && !installation.error && !installation.addon.appDisabled,
    "Zotero rejected the XPI manifest");
  await installation.install();
  await waitFor(() => Zotero.ChatGPTPDF?.open, "production addon startup");
  const targets = Zotero.MenuManager._menuManager.options.filter(option => option.pluginID === addonID).map(option => option.target);
  check(targets.includes("main/library/item") && targets.includes("main/menubar/tools"), "Addon menus were not registered");
  report.menus = targets;

  report.stage = "initialize-library";
  const pane = await waitFor(() => {
    const current = Zotero.getActiveZoteroPane();
    return current?.itemsView && current.collectionsView && current;
  }, "Zotero library views");
  await pane.collectionsView.selectLibrary(Zotero.Libraries.userLibraryID);
  await pane.onCollectionSelected();
  await waitFor(() => pane.itemsView.collectionTreeRows.length > 0, "populated library rows");

  const article = new Zotero.Item("journalArticle");
  article.setField("title", "Synthetic PDF translation fixture");
  report.stage = "create-fixture";
  await article.saveTx({ skipNotifier: true });
  await article.loadDataType("childItems");
  await Zotero.Notifier.trigger("add", "item", [article.id], {});
  const original = await Zotero.Attachments.importFromFile({
    file: profileFile("fixture.pdf").path, parentItemID: article.id, title: "Original PDF", contentType: "application/pdf",
  });
  await verifyReader(original, prefix);

  Zotero.Prefs.set(prefix + "python", Services.env.get("ZOTERO_TEST_PYTHON"), true);
  report.stage = "open-dialog";
  await pane.itemsView.selectItems([article.id]);
  check(pane.getSelectedItems(true).includes(article.id), "Synthetic fixture could not be selected in the Zotero library");
  const dialog = await Zotero.ChatGPTPDF.open();
  check(dialog, "No translation window was opened");
  const $ = id => dialog.document.getElementById(id);
  await waitFor(() => {
    report.dialogStatus = $("status")?.textContent;
    report.accountStatus = $("account-status")?.textContent;
    return $("models")?.disabled === false;
  }, "ChatGPT PDF dialog to show the saved account");
  report.stage = "load-models";
  $("models").click();
  await waitFor(() => !$("start").disabled && $("model").value === "native-test", "available model selection");
  report.stage = "probe-renderer";
  $("probe").click();
  await waitFor(() => {
    report.dialogStatus = $("status")?.textContent;
    if ($("status").classList.contains("error")) throw new Error(report.dialogStatus);
    return $("renderer-status").textContent.includes("已就绪");
  }, "local engine probe");

  report.stage = "translate-pdf";
  $("pages").value = "2";
  $("mode").value = "both";
  $("start").click();
  function translationFinished() {
    report.dialogStatus = $("status").textContent;
    report.queueStatus = $("items").textContent;
    return report.dialogStatus.startsWith("成功 ");
  }
  await waitFor(translationFinished, "render and attachment import", 90000);
  check($("status").textContent.includes("成功 1，失败 0") && report.requests > 0, $("status").textContent + " " + $("items").textContent);
  const attachments = await Zotero.Items.getAsync(article.getAttachments());
  check(attachments.length === 3 && attachments.some(item => item.id === original.id),
    "Expected the original and two new attachments");

  report.stage = "translate-alternating";
  $("mode").value = "dual";
  $("layout").value = "alternating";
  $("start").click();
  await waitFor(translationFinished, "alternating-page PDF", 75000);
  check($("status").textContent.includes("成功 1，失败 0"), $("status").textContent + " " + $("items").textContent);
  const alternate = (await Zotero.Items.getAsync(article.getAttachments())).find(item => item.getField("title").includes("交替页双语"));
  check(alternate, "Missing alternating-page attachment");

  report.stage = "verified-attachments";
  report.outputs = { alternate: await alternate.getFilePathAsync() };
  for (const item of attachments) {
    const title = item.getField("title");
    const kind = item.id === original.id ? "original" : title.includes("并排双语") ? "dual" : "mono";
    report.outputs[kind] = await item.getFilePathAsync();
  }
  dialog.close();
}
