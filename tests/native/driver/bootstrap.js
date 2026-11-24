/* SPDX-License-Identifier: AGPL-3.0-only */
/* This driver runs only in the disposable profile prepared by run.sh. */
var finished = false;
var report = { success: false, requests: 0 };
var addonID = "chatgpt-pdf@zotero.community";

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
  if (error) report.error = String(error.stack || error);
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
    const events = [
      { type: "response.output_text.delta", delta: translated },
      { type: "response.completed", response: { status: "completed", model: body.model } },
    ];
    return { status: 200, responseText: events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("") };
  };
}

async function run() {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  report.zotero = Zotero.version;
  check(Zotero.version === "10.0.8", "Unexpected Zotero version");
  const prefix = "extensions.zotero-chatgpt-pdf.";
  Zotero.Prefs.set(prefix + "python", Services.env.get("ZOTERO_TEST_PYTHON"), true);
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

  const article = new Zotero.Item("journalArticle");
  article.setField("title", "Synthetic PDF translation fixture");
  await article.saveTx();
  const original = await Zotero.Attachments.importFromFile({
    file: profileFile("fixture.pdf").path, parentItemID: article.id, title: "Original PDF", contentType: "application/pdf",
  });
  await Zotero.getActiveZoteroPane().selectItem(article.id);
  Zotero.ChatGPTPDF.open();
  const dialog = await waitFor(() => {
    const window = Services.wm.getMostRecentWindow("zotero:chatgpt-pdf");
    return window?.document.getElementById("models")?.disabled === false && window;
  }, "ChatGPT PDF dialog to show the saved account");
  const $ = id => dialog.document.getElementById(id);
  $("models").click();
  await waitFor(() => !$("start").disabled && $("model").value === "native-test", "available model selection");
  $("probe").click();
  await waitFor(() => $("renderer-status").textContent.includes("已就绪"), "local engine probe");

  $("pages").value = "2";
  $("mode").value = "both";
  $("start").click();
  await waitFor(() => $("status").textContent.startsWith("成功 "), "render and attachment import", 150000);
  check($("status").textContent.includes("成功 1，失败 0") && report.requests > 0, $("status").textContent + " " + $("items").textContent);
  const attachments = await Zotero.Items.getAsync(article.getAttachments());
  check(attachments.length === 3 && attachments.some(item => item.id === original.id),
    "Expected the original and two new attachments");

  report.outputs = {};
  for (const item of attachments) {
    const title = item.getField("title");
    const kind = item.id === original.id ? "original" : title.includes("并排双语") ? "dual" : "mono";
    report.outputs[kind] = await item.getFilePathAsync();
  }
  dialog.close();
}
