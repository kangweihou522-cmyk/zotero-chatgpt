/* SPDX-License-Identifier: AGPL-3.0-only */
var chromeHandle;
var pluginScope;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  const startupService = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = startupService.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "zotero-chatgpt-pdf", rootURI + "content/"],
  ]);
  pluginScope = {
    Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils, URL, crypto,
    Cc: Components.classes, Ci: Components.interfaces, setTimeout, clearTimeout,
  };
  pluginScope.globalThis = pluginScope;
  try {
    for (const file of ["chatgpt.js", "renderer.js", "main.js"]) {
      Services.scriptloader.loadSubScript(rootURI + "content/" + file, pluginScope, "UTF-8");
    }
    pluginScope.ChatGPTPDFMain.start({ id, version, rootURI });
  } catch (error) {
    shutdown({}, null);
    throw error;
  }
}

function onMainWindowLoad({ window }) {
  pluginScope?.ChatGPTPDFMain?.addWindow(window);
}

function onMainWindowUnload({ window }) {
  pluginScope?.ChatGPTPDFMain?.removeWindow(window);
}

function shutdown(_data, reason) {
  pluginScope?.ChatGPTPDFMain?.stop();
  pluginScope = null;
  if (reason !== APP_SHUTDOWN) chromeHandle?.destruct();
  chromeHandle = null;
}
