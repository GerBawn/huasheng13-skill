#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");

const DEFAULT_PORT = 17813;
const MAX_BODY = 2 * 1024 * 1024;

const TAXONOMY = [
  ["政治理论", ["新思想", "时事政治", "马克思主义", "毛中特"]],
  ["常识判断", ["政治", "经济", "法律", "人文历史", "科技生活", "地理国情"]],
  ["言语理解", ["逻辑填空", "中心理解", "细节判断", "标题填入", "语句排序", "语句填空", "接语理解"]],
  ["数量关系", ["工程问题", "行程问题", "利润问题", "排列组合", "概率", "容斥", "最值问题", "几何问题", "年龄问题", "比例问题", "数学运算"]],
  ["判断推理", ["图形推理", "定义判断", "类比推理", "翻译推理", "加强削弱", "前提假设", "真假推理", "日常结论"]],
  ["资料分析", ["增长量", "增长率", "比重", "两期比重", "平均数", "平均数增长量", "基期平均数", "倍数", "综合分析"]],
  ["申论", ["归纳概括", "综合分析", "提出对策", "贯彻执行", "申发论述"]],
];

const MODULE_ALIASES = {
  资料: "资料分析",
  资料分析: "资料分析",
  数量: "数量关系",
  数量关系: "数量关系",
  言语: "言语理解",
  言语理解: "言语理解",
  判断: "判断推理",
  判断推理: "判断推理",
  常识: "常识判断",
  常识判断: "常识判断",
  申论: "申论",
  政治理论: "政治理论",
  "言语理解与表达": "言语理解",
};

const TYPE_ALIASES = {
  两集合容斥: "容斥",
  容斥问题: "容斥",
  类比: "类比推理",
  "前提假设/搭桥": "前提假设",
  搭桥: "前提假设",
  比重升降: "两期比重",
  两期比重升降: "两期比重",
  增长: "增长量",
  工程: "工程问题",
  行程: "行程问题",
  利润: "利润问题",
  几何: "几何问题",
  年龄: "年龄问题",
  比例: "比例问题",
  最值: "最值问题",
  图形: "图形推理",
  定义: "定义判断",
  翻译: "翻译推理",
  加强: "加强削弱",
  削弱: "加强削弱",
  公文: "贯彻执行",
  大作文: "申发论述",
  作文: "申发论述",
};

function dataDir() {
  const override = process.env.GONGKAO_DATA_DIR;
  if (override) return path.resolve(override);
  return path.resolve(path.join(os.homedir(), "Documents", "公考练习记录"));
}

function ensureDirs(root) {
  for (const dir of ["sessions", "pages", "assignments", "qa"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeToken(value, fallback) {
  const token = String(value || "").replace(/[^\p{L}\p{N}_-]+/gu, "");
  return token || fallback;
}

function sessionFilename(record) {
  const sid = safeToken(record.sessionId || "", "practice");
  const started = record.startedAt || record.savedAt || nowIso();
  const ts = String(started).replace(/\D/g, "").slice(0, 14) || timestampLocal();
  return `gongkao-session-${sid}-${ts}.json`;
}

function timestampLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeJson(filePath, payload) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

function listSessionFiles(root) {
  const dir = path.join(root, "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith("gongkao-session-") && name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort();
}

function loadSessions(root) {
  const items = [];
  for (const filePath of listSessionFiles(root)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data && typeof data === "object" && !Array.isArray(data)) {
        items.push({ path: filePath, data });
      }
    } catch {
      // skip broken session files
    }
  }
  items.sort((a, b) => {
    const ka = a.data.savedAt || a.data.startedAt || path.basename(a.path);
    const kb = b.data.savedAt || b.data.startedAt || path.basename(b.path);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return items;
}

function bump(bucket, key, correct) {
  const name = key || "未分类";
  if (!bucket[name]) bucket[name] = { total: 0, correct: 0 };
  bucket[name].total += 1;
  if (correct) bucket[name].correct += 1;
}

function cuotiEntry(last, attempts, essay) {
  const wrongs = attempts.filter((a) => a.correct === false);
  return {
    id: last.id || "",
    module: last.module || "",
    type: last.type || "",
    kind: last.kind || (essay ? "essay" : "choice"),
    stem: last.stem || "",
    options: last.options || [],
    correctAnswer: last.correctAnswer || "",
    analysis: last.analysis || "",
    source: last.source || "",
    lastUserAnswer: last.userAnswer || "",
    wrongCount: wrongs.length,
    lastWrongAt: wrongs.length ? (wrongs[wrongs.length - 1].savedAt || "") : "",
    lastAnsweredAt: attempts[attempts.length - 1].savedAt || "",
    attempts: attempts.length,
  };
}

function isMastered(attempts) {
  const scored = attempts.filter((a) => a.correct !== null && a.correct !== undefined);
  return scored.length >= 2 && Boolean(scored[scored.length - 1].correct) && Boolean(scored[scored.length - 2].correct);
}

function rebuild(root) {
  const history = {};
  const byModule = {};
  const byType = {};
  const sessionRows = [];

  for (const { path: filePath, data: rec } of loadSessions(root)) {
    const summary = rec.summary || {};
    const savedAt = rec.savedAt || "";
    sessionRows.push({
      file: `sessions/${path.basename(filePath)}`,
      sessionId: rec.sessionId || "",
      title: rec.title || "",
      savedAt,
      accuracy: summary.accuracy,
      usedSeconds: rec.usedSeconds || 0,
      total: summary.total,
      correct: summary.correct,
    });
    for (const item of rec.items || []) {
      const qid = String(item.id || "");
      if (!qid) continue;
      const attempt = { ...item, savedAt, sessionId: rec.sessionId || "" };
      if (!history[qid]) history[qid] = [];
      history[qid].push(attempt);
      if (item.correct === null || item.correct === undefined) continue;
      bump(byModule, item.module || "", item.correct);
      bump(byType, item.type || "", item.correct);
    }
  }

  const mastered = [];
  const cuotiItems = [];
  const essays = [];
  for (const [qid, attempts] of Object.entries(history)) {
    const last = attempts[attempts.length - 1];
    if (last.correct === null || last.correct === undefined) {
      if (last.userAnswer) essays.push(cuotiEntry(last, attempts, true));
      continue;
    }
    const scored = attempts.filter((a) => a.correct !== null && a.correct !== undefined);
    if (scored.length >= 2 && scored[scored.length - 1].correct && scored[scored.length - 2].correct) {
      mastered.push(qid);
      continue;
    }
    if (scored.some((a) => a.correct === false)) {
      cuotiItems.push(cuotiEntry(last, attempts, false));
    }
  }

  const updated = nowIso();
  return {
    progress: {
      updatedAt: updated,
      sessions: sessionRows,
      byModule,
      byType,
      masteredIds: mastered,
    },
    cuoti: {
      updatedAt: updated,
      items: cuotiItems,
      essays,
    },
  };
}

function persistProgress(root) {
  const { progress, cuoti } = rebuild(root);
  writeJson(path.join(root, "progress.json"), progress);
  writeJson(path.join(root, "cuoti.json"), cuoti);
  return { progress, cuoti };
}

function validateRecord(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("记录必须是 JSON 对象");
  }
  if (!Array.isArray(payload.items)) {
    throw new Error("记录缺少 items");
  }
  return {
    ...payload,
    savedAt: payload.savedAt || nowIso(),
    sessionId: payload.sessionId || "practice",
  };
}

function canonModule(name) {
  const raw = String(name || "").trim() || "未分类";
  if (MODULE_ALIASES[raw]) return MODULE_ALIASES[raw];
  const officials = [...new Set(Object.values(MODULE_ALIASES))];
  for (const official of officials) {
    if (official.includes(raw) || raw.includes(official)) return official;
  }
  return raw;
}

function moduleTypes(module) {
  const found = TAXONOMY.find(([name]) => name === module);
  return found ? found[1].slice() : [];
}

function canonType(name, module) {
  const raw = String(name || "").trim() || "未分类";
  if (TYPE_ALIASES[raw]) return TYPE_ALIASES[raw];
  const official = moduleTypes(module);
  if (official.includes(raw)) return raw;
  const matches = official.filter((item) => raw.includes(item) || (raw.length >= 2 && item.includes(raw)));
  if (matches.length) return matches.reduce((a, b) => (a.length >= b.length ? a : b));
  return raw;
}

function masteryLevel(total, correct, cuotiCount) {
  if (total <= 0) return "未练";
  const accuracy = correct / total;
  if (total >= 3 && accuracy >= 0.8 && cuotiCount === 0) return "掌握";
  if ((total >= 3 && accuracy < 0.6) || cuotiCount >= 2 || (cuotiCount >= 1 && accuracy < 0.6)) return "薄弱";
  return "一般";
}

function statKey(module, typ) {
  return module + "\0" + typ;
}

function buildMap(root) {
  const { progress, cuoti } = persistProgress(root);
  const stats = new Map();
  const history = {};

  function ensure(module, typ) {
    const key = statKey(module, typ);
    if (!stats.has(key)) {
      stats.set(key, {
        module,
        type: typ,
        total: 0,
        correct: 0,
        cuotiCount: 0,
        uniqueCount: 0,
        everWrong: 0,
        masteredAfterWrong: 0,
      });
    }
    return stats.get(key);
  }

  for (const [name, types] of TAXONOMY) {
    for (const typ of types) ensure(name, typ);
  }

  for (const { data: rec } of loadSessions(root)) {
    const savedAt = rec.savedAt || "";
    for (const item of rec.items || []) {
      if (item.correct === null || item.correct === undefined) continue;
      const module = canonModule(item.module || "");
      const typ = canonType(item.type || "", module);
      const row = ensure(module, typ);
      row.total += 1;
      if (item.correct) row.correct += 1;
      const qid = String(item.id || "");
      if (!qid) continue;
      if (!history[qid]) history[qid] = [];
      history[qid].push({ correct: item.correct, module, type: typ, savedAt });
    }
  }

  for (const attempts of Object.values(history)) {
    const last = attempts[attempts.length - 1];
    const row = ensure(last.module, last.type);
    row.uniqueCount += 1;
    if (attempts.some((a) => a.correct === false)) {
      row.everWrong += 1;
      if (isMastered(attempts)) row.masteredAfterWrong += 1;
    }
  }

  for (const item of cuoti.items || []) {
    const module = canonModule(item.module || "");
    const typ = canonType(item.type || "", module);
    ensure(module, typ).cuotiCount += 1;
  }

  function packRow(name, total, correct, unique, everWrong, mastered, cuotiCount, types) {
    const wrong = Math.max(total - correct, 0);
    const accuracy = total ? correct / total : 0;
    const payload = {
      name,
      total,
      correct,
      wrong,
      accuracy: Math.round(accuracy * 1000) / 1000,
      uniqueCount: unique,
      everWrong,
      masteredAfterWrong: mastered,
      cuotiCount,
      level: masteryLevel(total, correct, cuotiCount),
    };
    if (types !== undefined) payload.types = types;
    return payload;
  }

  const seenModules = new Set(TAXONOMY.map(([name]) => name));
  const orderedModules = TAXONOMY.map(([name]) => name);
  for (const row of stats.values()) {
    if (!seenModules.has(row.module)) {
      orderedModules.push(row.module);
      seenModules.add(row.module);
    }
  }

  const levelCounts = { 未练: 0, 薄弱: 0, 一般: 0, 掌握: 0 };
  let practicedTypes = 0;
  const modules = [];
  for (const module of orderedModules) {
    const typeNames = moduleTypes(module);
    const extras = [];
    for (const row of stats.values()) {
      if (row.module === module && !typeNames.includes(row.type)) extras.push(row.type);
    }
    const typeRows = [];
    let mTotal = 0, mCorrect = 0, mCuoti = 0, mUnique = 0, mEver = 0, mMastered = 0;
    for (const typ of typeNames.concat(extras)) {
      const row = stats.get(statKey(module, typ)) || {};
      const packed = packRow(
        typ,
        row.total || 0,
        row.correct || 0,
        row.uniqueCount || 0,
        row.everWrong || 0,
        row.masteredAfterWrong || 0,
        row.cuotiCount || 0
      );
      levelCounts[packed.level] = (levelCounts[packed.level] || 0) + 1;
      if (packed.total) practicedTypes += 1;
      mTotal += packed.total;
      mCorrect += packed.correct;
      mCuoti += packed.cuotiCount;
      mUnique += packed.uniqueCount;
      mEver += packed.everWrong;
      mMastered += packed.masteredAfterWrong;
      typeRows.push(packed);
    }
    modules.push(packRow(module, mTotal, mCorrect, mUnique, mEver, mMastered, mCuoti, typeRows));
  }

  const attemptTotal = modules.reduce((s, m) => s + m.total, 0);
  const correctTotal = modules.reduce((s, m) => s + m.correct, 0);

  const paperStats = new Map();
  const zhentiIds = new Set();
  let zhentiAttempts = 0;
  let zhentiCorrect = 0;
  for (const { data: rec } of loadSessions(root)) {
    for (const item of rec.items || []) {
      if (item.correct === null || item.correct === undefined) continue;
      const paper = item.paper || item.source || rec.paper || rec.exam || "";
      const isZhenti = item.isZhenti === true || !!(item.qid || item.paper || rec.isZhenti);
      if (!isZhenti && !paper) continue;
      zhentiAttempts += 1;
      if (item.correct) zhentiCorrect += 1;
      const qid = String(item.qid || item.id || "");
      if (qid) zhentiIds.add(qid);
      const key = paper || "未注明试卷";
      if (!paperStats.has(key)) {
        paperStats.set(key, { name: key, year: item.year || rec.year || "", region: item.region || rec.region || "", total: 0, correct: 0, unique: new Set() });
      }
      const row = paperStats.get(key);
      row.total += 1;
      if (item.correct) row.correct += 1;
      if (qid) row.unique.add(qid);
      if (!row.year && (item.year || rec.year)) row.year = item.year || rec.year;
      if (!row.region && (item.region || rec.region)) row.region = item.region || rec.region;
    }
  }
  const papers = [...paperStats.values()].map((row) => ({
    name: row.name,
    year: row.year,
    region: row.region,
    total: row.total,
    correct: row.correct,
    wrong: Math.max(row.total - row.correct, 0),
    accuracy: row.total ? Math.round((row.correct / row.total) * 1000) / 1000 : 0,
    uniqueCount: row.unique.size,
  })).sort((a, b) => b.total - a.total || String(b.year).localeCompare(String(a.year)));

  return {
    updatedAt: progress.updatedAt || nowIso(),
    summary: {
      sessionCount: (progress.sessions || []).length,
      attemptCount: attemptTotal,
      correctCount: correctTotal,
      wrongCount: Math.max(attemptTotal - correctTotal, 0),
      uniqueCount: Object.keys(history).length,
      everWrong: modules.reduce((s, m) => s + m.everWrong, 0),
      masteredAfterWrong: modules.reduce((s, m) => s + m.masteredAfterWrong, 0),
      practicedTypes,
      cuotiCount: (cuoti.items || []).length,
      byLevel: levelCounts,
      zhentiAttemptCount: zhentiAttempts,
      zhentiCorrectCount: zhentiCorrect,
      zhentiUniqueCount: zhentiIds.size,
      paperCount: papers.length,
    },
    papers,
    modules,
  };
}


function listJsonRecords(root, dir, prefix) {
  const folder = path.join(root, dir);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(folder, name);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;
        return {
          file: dir + "/" + name,
          data,
          mtime: fs.statSync(filePath).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ka = a.data.savedAt || a.data.submittedAt || a.data.createdAt || a.data.askedAt || "";
      const kb = b.data.savedAt || b.data.submittedAt || b.data.createdAt || b.data.askedAt || "";
      if (ka !== kb) return ka < kb ? 1 : -1;
      return b.mtime - a.mtime;
    });
}

function assignmentFilename(record) {
  const sid = safeToken(record.sessionId || record.id || "", "paper");
  const created = record.createdAt || nowIso();
  const ts = String(created).replace(/\D/g, "").slice(0, 14) || timestampLocal();
  return "gongkao-assignment-" + sid + "-" + ts + ".json";
}

function qaFilename(record) {
  const sid = safeToken(record.id || record.qid || "qa", "qa");
  const created = record.askedAt || record.createdAt || nowIso();
  const ts = String(created).replace(/\D/g, "").slice(0, 14) || timestampLocal();
  return "gongkao-qa-" + sid + "-" + ts + ".json";
}

function validateAssignment(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("记录必须是 JSON 对象");
  }
  return {
    ...payload,
    id: payload.id || payload.sessionId || "paper",
    sessionId: payload.sessionId || payload.id || "paper",
    createdAt: payload.createdAt || nowIso(),
    status: payload.status || "assigned",
  };
}

function validateQa(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("记录必须是 JSON 对象");
  }
  if (!payload.stem && !payload.question) {
    throw new Error("记录缺少题干");
  }
  return {
    ...payload,
    id: payload.id || payload.qid || ("qa-" + Date.now()),
    stem: payload.stem || payload.question || "",
    askedAt: payload.askedAt || payload.createdAt || nowIso(),
    kind: payload.kind || "explain",
  };
}

function buildHome(root) {
  const assignments = listJsonRecords(root, "assignments", "gongkao-assignment-");
  const sessions = loadSessions(root).map(({ path: filePath, data }) => ({
    file: "sessions/" + path.basename(filePath),
    data,
    mtime: fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0,
  }));
  const sessionById = new Map();
  for (const row of sessions) {
    const rec = row.data;
    const key = rec.sessionId || rec.id || row.file;
    const prev = sessionById.get(key);
    const ts = rec.savedAt || rec.startedAt || "";
    if (!prev || (prev.data.savedAt || prev.data.startedAt || "") <= ts) sessionById.set(key, row);
  }

  const papers = [];
  const seen = new Set();
  function pushPaper(row, kind) {
    const rec = row.data;
    const sessionId = rec.sessionId || rec.id || "";
    const session = sessionId ? sessionById.get(sessionId) : null;
    const submitted = kind === "session" || rec.status === "submitted" || !!(session && (session.data.summary || session.data.items));
    const src = submitted && session ? session.data : rec;
    const summary = src.summary || rec.summary || {};
    const key = row.file + "::" + (sessionId || rec.paper || rec.title || "");
    if (seen.has(key)) return;
    seen.add(key);
    papers.push({
      sessionId,
      title: rec.title || src.title || rec.paper || src.exam || "未命名试卷",
      paper: rec.paper || src.paper || rec.exam || src.exam || "",
      year: rec.year || src.year || "",
      region: rec.region || src.region || "",
      mode: rec.mode || src.mode || "",
      isZhenti: !!(rec.isZhenti || src.isZhenti),
      questionCount: rec.questionCount || (rec.questions || rec.items || []).length || summary.total || 0,
      total: summary.total || rec.questionCount || 0,
      scored: summary.scored,
      correct: summary.correct,
      accuracy: summary.accuracy,
      page: rec.page || src.page || "",
      createdAt: rec.createdAt || rec.startedAt || src.startedAt || rec.savedAt,
      submittedAt: submitted ? (src.savedAt || rec.submittedAt || "") : "",
      submitted,
    });
  }
  assignments.forEach((row) => pushPaper(row, "assignment"));
  for (const row of sessions) {
    const sid = row.data.sessionId || row.data.id || "";
    const already = papers.some((p) => p.sessionId && sid && p.sessionId === sid);
    if (!already) pushPaper(row, "session");
  }
  papers.sort((a, b) => String(b.createdAt || b.submittedAt || "").localeCompare(String(a.createdAt || a.submittedAt || "")));

  const questions = [];
  for (const row of listJsonRecords(root, "qa", "gongkao-qa-")) {
    const rec = row.data;
    questions.push({
      id: rec.id || rec.qid || row.file,
      qid: rec.qid || "",
      stem: rec.stem || rec.question || "",
      module: rec.module || "",
      type: rec.type || "",
      paper: rec.paper || rec.source || "",
      questionNo: rec.questionNo || "",
      kind: rec.kind || "explain",
      correct: rec.correct,
      at: rec.askedAt || rec.createdAt || "",
      analysis: rec.analysis || "",
    });
  }
  for (const { data: rec } of loadSessions(root)) {
    for (const item of rec.items || []) {
      questions.push({
        id: item.id || item.qid || "",
        qid: item.qid || "",
        stem: item.stem || "",
        module: item.module || "",
        type: item.type || "",
        paper: item.paper || item.source || rec.paper || rec.exam || "",
        questionNo: item.questionNo || "",
        kind: "practice",
        correct: item.correct,
        at: rec.savedAt || rec.startedAt || "",
        analysis: item.analysis || "",
      });
    }
  }
  questions.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));

  return {
    updatedAt: nowIso(),
    latest: papers[0] || null,
    papers,
    questions,
  };
}

function readTemplate(names, fallback) {
  const here = path.dirname(__filename);
  const bases = [here, path.join(here, "..", "templates")];
  for (const name of names) {
    for (const base of bases) {
      const candidate = path.join(base, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, "utf8");
      }
    }
  }
  return fallback;
}

function mapPageHtml() {
  return readTemplate(["home.html", "map.html"], "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='UTF-8'><title>公考练习</title></head><body><p>缺少 home.html。</p></body></html>");
}

function homePageHtml() {
  return mapPageHtml();
}

function indexPage(root) {
  const pagesDir = path.join(root, "pages");
  let pages = [];
  if (fs.existsSync(pagesDir)) {
    pages = fs.readdirSync(pagesDir)
      .filter((name) => name.endsWith(".html"))
      .map((name) => {
        const full = path.join(pagesDir, name);
        return { name, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
  const links = pages.length
    ? pages.map((p) => `<li><a href="/pages/${encodeURIComponent(p.name)}">${escapeHtml(p.name)}</a></li>`).join("\n")
    : "<li>还没有练习页</li>";
  const sessions = listSessionFiles(root);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>公考记录服务</title>
  <style>
    body { font: 16px/1.6 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1f1b16; background: #f6f3ee; }
    a { color: #2d4a6e; }
  </style>
</head>
<body>
  <h1>公考记录服务已启动</h1>
  <p>记录目录：<code>${escapeHtml(root)}</code></p>
  <p>已保存场次：${sessions.length}</p>
  <p><a href="/map">打开能力地图</a></p>
  <h2>练习页</h2>
  <ul>${links}</ul>
  <p>交卷会自动写入 <code>sessions/</code>，并更新 <code>progress.json</code> 和 <code>cuoti.json</code>。</p>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  res.writeHead(code, corsHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
  }));
  res.end(body);
}

function sendBytes(res, code, body, ctype) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, corsHeaders({
    "Content-Type": ctype,
    "Content-Length": String(buf.length),
  }));
  res.end(buf);
}

function corsHeaders(extra) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function safePagePath(root, rel) {
  const pages = path.resolve(path.join(root, "pages"));
  const target = path.resolve(path.join(pages, rel));
  const prefix = pages.endsWith(path.sep) ? pages : pages + path.sep;
  if (target !== pages && !target.startsWith(prefix)) return null;
  return target;
}

function createHandler(root, port) {
  return (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET") {
      if (pathname === "/" || pathname === "/index.html" || pathname === "/home" || pathname === "/home.html") {
        sendBytes(res, 200, homePageHtml(), "text/html; charset=utf-8");
        return;
      }
      if (pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          runtime: "node",
          dataDir: root,
          sessionCount: listSessionFiles(root).length,
          port,
          homeUrl: "http://127.0.0.1:" + port + "/",
          mapUrl: "http://127.0.0.1:" + port + "/map",
        });
        return;
      }
      if (pathname === "/api/home") {
        sendJson(res, 200, { ok: true, home: buildHome(root) });
        return;
      }
      if (pathname === "/api/assignments") {
        sendJson(res, 200, { ok: true, assignments: listJsonRecords(root, "assignments", "gongkao-assignment-").map((row) => ({ file: row.file, ...row.data })) });
        return;
      }
      if (pathname === "/api/qa") {
        sendJson(res, 200, { ok: true, qa: listJsonRecords(root, "qa", "gongkao-qa-").map((row) => ({ file: row.file, ...row.data })) });
        return;
      }
      if (pathname === "/api/progress") {
        persistProgress(root);
        sendJson(res, 200, { ok: true, progress: loadJson(path.join(root, "progress.json"), {}) });
        return;
      }
      if (pathname === "/api/cuoti") {
        persistProgress(root);
        sendJson(res, 200, { ok: true, cuoti: loadJson(path.join(root, "cuoti.json"), {}) });
        return;
      }
      if (pathname === "/api/map") {
        sendJson(res, 200, { ok: true, map: buildMap(root) });
        return;
      }
      if (pathname === "/map" || pathname === "/map.html") {
        sendBytes(res, 200, homePageHtml(), "text/html; charset=utf-8");
        return;
      }
      if (pathname.startsWith("/pages/")) {
        const rel = pathname.slice("/pages/".length);
        const target = safePagePath(root, rel);
        if (!target) {
          sendJson(res, 403, { ok: false, error: "路径不允许" });
          return;
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          sendJson(res, 404, { ok: false, error: "页面不存在" });
          return;
        }
        const ext = path.extname(target).toLowerCase();
        const ctype = ext === ".html" || ext === ".htm" ? "text/html; charset=utf-8" : "application/octet-stream";
        sendBytes(res, 200, fs.readFileSync(target), ctype);
        return;
      }
      sendJson(res, 404, { ok: false, error: "未找到接口" });
      return;
    }

    if (req.method === "POST") {
      if (!["/api/sessions", "/api/assignments", "/api/qa"].includes(pathname)) {
        sendJson(res, 404, { ok: false, error: "未找到接口" });
        return;
      }
      const length = Number(req.headers["content-length"] || 0);
      if (!length || length > MAX_BODY) {
        sendJson(res, 400, { ok: false, error: "请求体无效或过大" });
        return;
      }
      const chunks = [];
      let received = 0;
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (pathname === "/api/sessions") {
            const record = validateRecord(payload);
            const filename = sessionFilename(record);
            writeJson(path.join(root, "sessions", filename), record);
            const { progress, cuoti } = persistProgress(root);
            sendJson(res, 200, {
              ok: true,
              file: "sessions/" + filename,
              dataDir: root,
              summary: record.summary || {},
              progress,
              cuotiCount: (cuoti.items || []).length,
            });
            return;
          }
          if (pathname === "/api/assignments") {
            const record = validateAssignment(payload);
            const filename = assignmentFilename(record);
            writeJson(path.join(root, "assignments", filename), record);
            sendJson(res, 200, { ok: true, file: "assignments/" + filename, assignment: record });
            return;
          }
          const record = validateQa(payload);
          const filename = qaFilename(record);
          writeJson(path.join(root, "qa", filename), record);
          sendJson(res, 200, { ok: true, file: "qa/" + filename, qa: record });
        } catch (err) {
          if (err instanceof SyntaxError) {
            sendJson(res, 400, { ok: false, error: "JSON 无法解析" });
            return;
          }
          sendJson(res, 400, { ok: false, error: err.message || "记录无效" });
        }
      });
      req.on("error", () => {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: "请求体无效或过大" });
      });
      return;
    }

    sendJson(res, 405, { ok: false, error: "方法不允许" });
  };
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({
      host: "127.0.0.1",
      port,
      path: "/api/health",
      timeout: 1000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function parseArgs(argv) {
  const args = { port: Number(process.env.GONGKAO_PORT || DEFAULT_PORT), dataDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      args.port = Number(a.slice("--port=".length));
    } else if (a === "--data-dir" && argv[i + 1]) {
      args.dataDir = argv[++i];
    } else if (a.startsWith("--data-dir=")) {
      args.dataDir = a.slice("--data-dir=".length);
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    throw new Error("端口无效");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const root = args.dataDir ? path.resolve(args.dataDir) : dataDir();
  ensureDirs(root);
  persistProgress(root);

  const existing = await probe(args.port);
  if (existing && existing.ok && existing.runtime === "node") {
    console.log(`公考记录服务已在运行：http://127.0.0.1:${args.port}`);
    console.log(`记录目录：${existing.dataDir || root}`);
    console.log(`能力地图：http://127.0.0.1:${args.port}/map`);
    return 0;
  }
  if (existing && existing.ok) {
    console.error(`127.0.0.1:${args.port} 上已有旧版记录服务在运行，请先停止后再启动 Node 版本。`);
    return 1;
  }

  const server = http.createServer(createHandler(root, args.port));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(args.port, "127.0.0.1", resolve);
    });
  } catch (err) {
    console.error(`无法监听 127.0.0.1:${args.port}：${err.message}`);
    return 1;
  }

  console.log(`公考记录服务已启动：http://127.0.0.1:${args.port}`);
  console.log(`记录目录：${root}`);
  console.log(`能力地图：http://127.0.0.1:${args.port}/map`);
  console.log("只监听本机。按 Ctrl+C 停止。");

  const stop = () => {
    server.close(() => {
      console.log("\n已停止。");
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return null;
}

if (require.main === module) {
  main().then((code) => {
    if (code != null) process.exit(code);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildMap, persistProgress, canonType, canonModule, sessionFilename };
