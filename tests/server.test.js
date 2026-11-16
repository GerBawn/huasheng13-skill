"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const server = require("../tools/gongkao-server.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gongkao-test-"));
}

function writeSession(root, filename, rec) {
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(rec, null, 2) + "\n");
}

function scoredItem(id, correct) {
  return {
    id,
    qid: id,
    module: "言语理解",
    type: "逻辑填空",
    kind: "choice",
    stem: "题干" + id,
    options: ["A", "B", "C", "D"],
    userAnswer: correct ? "A" : "B",
    correctAnswer: "A",
    correct,
  };
}

function submittedRecord(overrides = {}) {
  return {
    savedAt: "2026-11-16T12:00:00Z",
    startedAt: "2026-11-16T11:00:00Z",
    submitted: true,
    sessionId: "paper-1",
    title: "一套练习",
    exam: "2025年国考副省级",
    usedSeconds: 600,
    items: [scoredItem("q1", true), scoredItem("q2", false)],
    summary: { total: 2, scored: 2, correct: 1, accuracy: 0.5 },
    ...overrides,
  };
}

async function listen(root) {
  const httpServer = http.createServer(server.createHandler(root, 0));
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = httpServer.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

async function jsonReq(base, method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

describe("session read and overwrite", () => {
  let root;
  beforeEach(() => {
    root = tmpRoot();
    server.ensureDirs(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes one file per sessionId and overwrites it", async () => {
    const httpServer = await listen(root);
    try {
      const first = submittedRecord({
        submitted: false,
        startedAt: "2026-11-16T11:00:00Z",
        savedAt: "2026-11-16T11:05:00Z",
        usedSeconds: 300,
        items: [scoredItem("q1", true)],
        summary: { total: 2, scored: 1, correct: 1, accuracy: 1 },
      });
      const a = await jsonReq(httpServer.url, "POST", "/api/sessions", first);
      assert.equal(a.status, 200);
      assert.equal(a.data.file, "sessions/gongkao-session-paper-1.json");

      const second = submittedRecord({
        startedAt: "2026-11-16T11:00:00Z",
        savedAt: "2026-11-16T11:20:00Z",
        usedSeconds: 1200,
        submitted: true,
      });
      const b = await jsonReq(httpServer.url, "POST", "/api/sessions", second);
      assert.equal(b.status, 200);
      assert.equal(b.data.file, "sessions/gongkao-session-paper-1.json");

      const files = fs.readdirSync(path.join(root, "sessions"));
      assert.deepEqual(files, ["gongkao-session-paper-1.json"]);

      const got = await jsonReq(httpServer.url, "GET", "/api/sessions/paper-1");
      assert.equal(got.status, 200);
      assert.equal(got.data.session.submitted, true);
      assert.equal(got.data.session.startedAt, "2026-11-16T11:00:00Z");
      assert.equal(got.data.session.usedSeconds, 1200);
    } finally {
      await httpServer.close();
    }
  });

  it("GET prefers the latest submitted record when multiple files exist", () => {
    writeSession(root, "gongkao-session-paper-1-20261116110000.json", submittedRecord({
      savedAt: "2026-11-16T11:10:00Z",
      submitted: true,
      usedSeconds: 100,
      items: [scoredItem("q1", true)],
      summary: { total: 1, scored: 1, correct: 1, accuracy: 1 },
    }));
    writeSession(root, "gongkao-session-paper-1-20261116120000.json", submittedRecord({
      savedAt: "2026-11-16T12:00:00Z",
      submitted: true,
      usedSeconds: 999,
      items: [scoredItem("q1", false), scoredItem("q2", false)],
      summary: { total: 2, scored: 2, correct: 0, accuracy: 0 },
    }));
    writeSession(root, "gongkao-session-paper-1-draft.json", submittedRecord({
      savedAt: "2026-11-16T13:00:00Z",
      submitted: false,
      usedSeconds: 50,
    }));
    const rec = server.loadSessionById(root, "paper-1");
    assert.equal(rec.usedSeconds, 999);
    assert.equal(rec.submitted, true);
  });

  it("prefers an answered legacy record over a later blank auto-submit", () => {
    writeSession(root, "gongkao-session-paper-1-20261116144046.json", submittedRecord({
      savedAt: "2026-11-16T14:41:54Z",
      startedAt: "2026-11-16T14:40:46Z",
      usedSeconds: 49,
      items: [scoredItem("q1", false), scoredItem("q2", true)],
      summary: { total: 2, scored: 2, correct: 1, accuracy: 0.5 },
    }));
    const answered = server.loadSessionById(root, "paper-1");
    delete answered.submitted;
    writeSession(root, "gongkao-session-paper-1-20261116144046.json", answered);

    const blank = submittedRecord({
      savedAt: "2026-11-16T15:06:38Z",
      startedAt: "2026-11-16T14:51:36Z",
      usedSeconds: 902,
      items: [
        { ...scoredItem("q1", false), userAnswer: "", correct: false },
        { ...scoredItem("q2", false), userAnswer: "", correct: false },
      ],
      summary: { total: 2, scored: 2, correct: 0, accuracy: 0 },
    });
    delete blank.submitted;
    writeSession(root, "gongkao-session-paper-1-20261116145136.json", blank);

    const rec = server.loadSessionById(root, "paper-1");
    assert.equal(rec.usedSeconds, 49);
    assert.equal(rec.summary.correct, 1);
    assert.equal((rec.items[0] || {}).userAnswer, "B");

    const home = server.buildHome(root);
    assert.ok(home);
    assert.equal(home.papers[0].correct, 1);
    const map = server.buildMap(root);
    assert.equal(map.summary.sessionCount, 1);
    assert.equal(map.summary.attemptCount, 2);
  });

  it("does not let a draft overwrite a submitted record", () => {
    writeSession(root, "gongkao-session-paper-1-old.json", submittedRecord({
      savedAt: "2026-11-16T11:00:00Z",
      submitted: true,
    }));
    const dest = server.resolveSessionWritePath(root, { sessionId: "paper-1", submitted: false });
    assert.equal(path.basename(dest), "gongkao-session-paper-1-draft.json");
  });

  it("overwrites an existing same-sessionId file instead of creating another", () => {
    writeSession(root, "gongkao-session-paper-1-old.json", submittedRecord({
      savedAt: "2026-11-16T11:00:00Z",
      startedAt: "2026-11-16T10:00:00Z",
    }));
    const dest = server.resolveSessionWritePath(root, { sessionId: "paper-1" });
    assert.equal(path.basename(dest), "gongkao-session-paper-1-old.json");
  });
});

describe("scoring ignores drafts and duplicate session files", () => {
  let root;
  beforeEach(() => {
    root = tmpRoot();
    server.ensureDirs(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not count unsubmitted drafts in progress or the ability map", () => {
    writeSession(root, "gongkao-session-paper-1.json", submittedRecord({
      submitted: false,
      items: [scoredItem("q1", true), scoredItem("q2", false)],
      summary: { total: 2, scored: 2, correct: 1, accuracy: 0.5 },
    }));
    const { progress } = server.persistProgress(root);
    assert.equal(progress.sessions.length, 0);
    assert.equal((progress.byModule["言语理解"] || { total: 0 }).total, 0);
    const map = server.buildMap(root);
    assert.equal(map.summary.attemptCount, 0);
    assert.equal(map.summary.sessionCount, 0);
  });

  it("counts a sessionId only once when leftover files exist", () => {
    writeSession(root, "gongkao-session-paper-1-a.json", submittedRecord({
      savedAt: "2026-11-16T11:00:00Z",
      submitted: true,
      items: [scoredItem("q1", true), scoredItem("q2", true)],
      summary: { total: 2, scored: 2, correct: 2, accuracy: 1 },
    }));
    writeSession(root, "gongkao-session-paper-1-b.json", submittedRecord({
      savedAt: "2026-11-16T12:00:00Z",
      submitted: true,
      items: [scoredItem("q1", true), scoredItem("q2", false)],
      summary: { total: 2, scored: 2, correct: 1, accuracy: 0.5 },
    }));
    const { progress } = server.persistProgress(root);
    assert.equal(progress.sessions.length, 1);
    assert.equal(progress.byModule["言语理解"].total, 2);
    assert.equal(progress.byModule["言语理解"].correct, 1);
    const map = server.buildMap(root);
    assert.equal(map.summary.attemptCount, 2);
    assert.equal(map.summary.sessionCount, 1);
  });

  it("treats legacy records without a submitted flag as submitted", () => {
    const rec = submittedRecord();
    delete rec.submitted;
    writeSession(root, "gongkao-session-legacy.json", rec);
    const { progress } = server.persistProgress(root);
    assert.equal(progress.sessions.length, 1);
    assert.equal(progress.byModule["言语理解"].total, 2);
  });
});

describe("buildHome history questions", () => {
  let root;
  beforeEach(() => {
    root = tmpRoot();
    server.ensureDirs(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists only qa explanations, not practiced exam items", () => {
    writeSession(root, "gongkao-session-paper-1.json", submittedRecord());
    const qaDir = path.join(root, "qa");
    fs.writeFileSync(path.join(qaDir, "gongkao-qa-demo-20261116.json"), JSON.stringify({
      id: "qa-1",
      stem: "专门讲解过的一道题",
      module: "判断推理",
      type: "图形推理",
      paper: "2025年国考副省级",
      kind: "explain",
      askedAt: "2026-11-16T09:00:00Z",
      analysis: "要点",
    }, null, 2) + "\n");

    const home = server.buildHome(root);
    assert.equal(home.questions.length, 1);
    assert.equal(home.questions[0].stem, "专门讲解过的一道题");
    assert.equal(home.questions[0].kind, "explain");
    assert.equal(home.questions.every((q) => q.kind !== "practice"), true);
    assert.ok(home.papers.length >= 1);
  });
});
