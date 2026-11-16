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
  ["常识判断", ["政治", "经济", "法律", "人文历史", "科技生活", "地理国情"]],
  ["言语理解", ["逻辑填空", "中心理解", "细节判断", "标题填入", "语句排序", "语句填空", "接语理解"]],
  ["数量关系", ["工程问题", "行程问题", "利润问题", "排列组合", "概率", "容斥", "最值问题", "几何问题", "年龄问题", "比例问题"]],
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
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
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
    },
    modules,
  };
}

function mapPageHtml() {
  const here = path.dirname(__filename);
  const candidates = [path.join(here, "map.html"), path.join(here, "..", "templates", "map.html")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='UTF-8'><title>能力地图</title></head><body><p>缺少 map.html。</p></body></html>";
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
      if (pathname === "/" || pathname === "/index.html") {
        sendBytes(res, 200, indexPage(root), "text/html; charset=utf-8");
        return;
      }
      if (pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          runtime: "node",
          dataDir: root,
          sessionCount: listSessionFiles(root).length,
          port,
          mapUrl: `http://127.0.0.1:${port}/map`,
        });
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
        sendBytes(res, 200, mapPageHtml(), "text/html; charset=utf-8");
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
      if (pathname !== "/api/sessions") {
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
          const record = validateRecord(payload);
          const filename = sessionFilename(record);
          const dest = path.join(root, "sessions", filename);
          writeJson(dest, record);
          const { progress, cuoti } = persistProgress(root);
          sendJson(res, 200, {
            ok: true,
            file: `sessions/${filename}`,
            dataDir: root,
            summary: record.summary || {},
            progress,
            cuotiCount: (cuoti.items || []).length,
          });
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
