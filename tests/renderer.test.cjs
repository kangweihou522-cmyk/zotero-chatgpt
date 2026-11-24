/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const test = require("node:test");
const { setImmediate } = require("node:timers/promises");
const renderer = require("../addon/content/renderer.js");

function fixture(chunks, handler = {}) {
  const writes = [];
  const used = [];
  let killed = false;
  let removed = false;
  const worker = {
    wait: async () => ({ exitCode: handler.exitCode || 0 }),
    stdin: { write: async text => writes.push(JSON.parse(text)) },
    stdout: { readString: async () => handler.readString ? handler.readString() : chunks.shift() || "" },
    kill: async () => { killed = true; handler.onKill?.(); },
  };
  const run = renderer.create({
    Zotero: { debug() {}, File: { getContentsFromURLAsync: async () => "worker.py" } },
    ChromeUtils: { importESModule: () => ({ Subprocess: { call: async options => {
      assert.equal(options.command, "/venv/bin/python");
      assert.deepEqual(options.arguments, ["-I", "-u", "/tmp/job/render_pdf.py"]);
      return worker;
    } } }) },
    IOUtils: {
      exists: async () => true,
      createUniqueDirectory: async () => "/tmp/job",
      writeUTF8: async () => {},
      read: async file => new TextEncoder().encode(handler.badPDF && file.endsWith("dual.pdf") ? "ERROR" : "%PDF-"),
      remove: async () => { removed = true; },
    },
    PathUtils: { isAbsolute: path => path.startsWith("/"), join: (...parts) => parts.join("/"), tempDir: "/tmp" },
    auth: { generate: async ({ messages, model }) => {
      assert.equal(model, "subscription-fixture");
      assert.equal(messages[1].content, "从 PDF 提取的文字");
      if (handler.authError) throw handler.authError;
      return { text: "译文" };
    } },
    rootURI: "jar:file:///addon.xpi!/",
  });
  function render(signal) {
    return run.render("/venv/bin/python", { input: "/本地/论文.pdf", mode: "both" }, {
      model: "subscription-fixture",
      signal,
      useOutput: files => { used.push(...files); return files.length; },
    });
  }
  return { run, render, writes, used, cleaned: () => killed && removed };
}

const start = '{"type":"translate","id":1,"prompt":"从 PDF 提取的文字"}\n';
const done = '{"type":"done","outputs":["mono","dual"]}\n';

test("page range normalization rejects reversed and empty ranges", () => {
  assert.equal(renderer.getPages("1， 3–5"), "1,3-5");
  assert.throws(() => renderer.getPages("5-3"), /页码/);
  assert.throws(() => renderer.getPages("1,"), /页码/);
});

test("translation pipe waits for both validated PDFs before importing", async () => {
  const job = fixture([start.slice(0, 4), start.slice(4) + done]);
  assert.equal(await job.render(), 2);
  assert.deepEqual(job.writes[1], { type: "translation", id: 1, text: "译文" });
  assert.equal(job.writes[0].input, "/本地/论文.pdf");
  assert.deepEqual(job.used.map(file => file.kind), ["mono", "dual"]);
  assert.equal(job.cleaned(), true);
});

test("partial and invalid outputs or ChatGPT failures never import files", async () => {
  for (const [chunks, handler, expected] of [
    [[done], { badPDF: true }, /有效的 PDF/],
    [[start], {}, /提前结束/],
    [[start, done], { authError: new Error("quota exhausted") }, /quota exhausted/],
  ]) {
    const job = fixture(chunks, handler);
    await assert.rejects(job.render(), expected);
    assert.deepEqual(job.used, []);
    assert.equal(job.cleaned(), true);
  }
});

test("stopping a waiting renderer kills it and discards temporary output", async () => {
  let finishRead;
  let waiting = false;
  const job = fixture([], {
    readString: () => {
      waiting = true;
      return new Promise(resolve => { finishRead = resolve; });
    },
    onKill: () => finishRead?.(""),
  });
  const controller = new AbortController();
  const result = job.render(controller.signal);
  while (!waiting) await setImmediate();
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(job.used, []);
  assert.equal(job.cleaned(), true);
});
