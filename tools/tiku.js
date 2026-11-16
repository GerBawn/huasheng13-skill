#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const BANK_REPO = "https://github.com/ERRRC/xingcezhenti";
const MODULE_DIRS = [
  ["01-政治理论", "政治理论"],
  ["02-常识判断", "常识判断"],
  ["03-言语理解与表达", "言语理解"],
  ["04-数量关系", "数量关系"],
  ["05-判断推理", "判断推理"],
  ["06-资料分析", "资料分析"],
];

const TYPE_ALIASES = {
  两集合容斥: "容斥",
  容斥问题: "容斥",
  类比: "类比推理",
  "前提假设/搭桥": "前提假设",
  搭桥: "前提假设",
  比重升降: "两期比重",
  两期比重升降: "两期比重",
  增长: "增长率",
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
  综合: "综合分析",
  逻辑填空: "逻辑填空",
  中心理解: "中心理解",
  细节判断: "细节判断",
  数学运算: "数学运算",
};

const QTY_HINTS = [
  [/容斥|两个项目都|既参加A|都不参与/, "容斥"],
  [/工程问题|完工|效率|水管|注水/, "工程问题"],
  [/相遇|追及|环形跑道|行程/, "行程问题"],
  [/利润|售价|进价|折扣|成本价/, "利润问题"],
  [/排列组合|有多少种排法/, "排列组合"],
  [/概率|随机抽取/, "概率"],
  [/三角形|圆形|正方形|长方体|表面积|体积/, "几何问题"],
  [/年龄|多少岁/, "年龄问题"],
  [/是.+的多少倍|载货量是/, "比例问题"],
  [/最多|最少|至多|至少|最大可能|最小可能/, "最值问题"],
];

function defaultBankDir() {
  if (process.env.GONGKAO_TIKU_DIR) return path.resolve(process.env.GONGKAO_TIKU_DIR);
  const candidates = [
    "/home/box/data/xingcezhenti",
    path.join(os.homedir(), "Documents", "公考练习记录", "xingcezhenti"),
    path.join(os.homedir(), "data", "xingcezhenti"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "README.md"))) || candidates[0];
}

function defaultIndexPath() {
  if (process.env.GONGKAO_TIKU_INDEX) return path.resolve(process.env.GONGKAO_TIKU_INDEX);
  const bank = defaultBankDir();
  return path.join(path.dirname(bank), "tiku-index.json");
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[kv[1].trim()] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyType(module, raw, stem) {
  const tag = String(raw || "").trim();
  if (TYPE_ALIASES[tag] && tag !== "数学运算" && tag !== "增长") {
    return TYPE_ALIASES[tag];
  }
  if (module === "数量关系") {
    for (const [re, name] of QTY_HINTS) {
      if (re.test(stem || "") || re.test(tag)) return name;
    }
    return tag && tag !== "数学运算" ? (TYPE_ALIASES[tag] || tag) : "数学运算";
  }
  if (module === "资料分析") {
    if (tag === "增长") {
      if (/增长量|多了多少|增加了多少/.test(stem || "")) return "增长量";
      return "增长率";
    }
    if (TYPE_ALIASES[tag]) return TYPE_ALIASES[tag];
    return tag || "综合分析";
  }
  return TYPE_ALIASES[tag] || tag || "未分类";
}

function parseOptions(block) {
  const options = [];
  let answer = "";
  const re = /^-\s+\*\*([A-D])\*\*[\.、．]?\s*(.*)$/gm;
  let m;
  while ((m = re.exec(block))) {
    let text = m[2].replace(/\s*✅\s*$/u, "").trim();
    if (/✅/.test(m[2])) answer = m[1];
    options.push(text);
  }
  const ans = block.match(/\*\*答案\*\*：\s*([A-D]+)/);
  if (ans) answer = ans[1];
  return { options, answer };
}

function parseAnalysis(block) {
  const m = block.match(/\*\*官方解析\*\*\s*([\s\S]*)$/);
  if (!m) return "";
  return m[1].replace(/^\s*\n/, "").replace(/\n---\s*$/, "").trim();
}

function extractStem(block) {
  const cut = block.search(/\n- \*\*[A-D]\*\*|\n\*\*答案\*\*|\n\*\*官方解析\*\*/);
  const raw = (cut >= 0 ? block.slice(0, cut) : block).trim();
  return raw;
}

function findImages(html) {
  const out = [];
  const re = /(?:src|href)=["']([^"']+90-图片\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(html || ""))) out.push(m[1]);
  return out;
}

function parseMarkdown(text, info = {}) {
  const { meta, body } = parseFrontmatter(text);
  const paper = meta["试卷"] || info.paper || "";
  const year = String(meta["年份"] || info.year || "");
  const region = meta["地区"] || info.region || "";
  const module = info.module || meta["模块"] || "";
  const questions = [];
  const materials = [];

  const lines = body.split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const mat = line.match(/^##\s*材料\s*(\d+)\s*$/);
    const q = line.match(/^(#{2,3})\s*第\s*(\d+)\s*题\s*(?:<sub>\s*qid\s+(\d+)\s*(?:·\s*([^<]+?))?\s*<\/sub>)?\s*$/u);
    if (mat) {
      if (current) blocks.push(current);
      current = { kind: "material", no: Number(mat[1]), lines: [] };
      continue;
    }
    if (q) {
      if (current) blocks.push(current);
      current = {
        kind: "question",
        no: Number(q[2]),
        qid: q[3] || "",
        typeRaw: (q[4] || "").trim(),
        lines: [],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  let currentMaterial = null;
  for (const block of blocks) {
    const raw = block.lines.join("\n").trim();
    if (block.kind === "material") {
      const id = `m-${paper}-${module}-${block.no}`;
      currentMaterial = {
        id,
        no: block.no,
        title: `材料 ${block.no}`,
        html: raw,
      };
      materials.push(currentMaterial);
      continue;
    }
    const { options, answer } = parseOptions(raw);
    const stem = extractStem(raw);
    const analysis = parseAnalysis(raw);
    const type = classifyType(module, block.typeRaw, stripHtml(stem));
    const qid = block.qid || `${paper}:${module}:${block.no}`;
    const images = [...findImages(stem), ...findImages(analysis), ...findImages(currentMaterial ? currentMaterial.html : "")];
    questions.push({
      id: `qid-${qid}`,
      qid: String(qid),
      questionNo: block.no,
      paper,
      year,
      region,
      module,
      typeRaw: block.typeRaw,
      type,
      stem,
      options,
      answer,
      analysis,
      materialId: currentMaterial ? currentMaterial.id : "",
      hasImages: images.length > 0,
      images,
      isZhenti: true,
      source: paper,
    });
  }

  return {
    paper,
    year,
    region,
    module,
    source: meta["来源"] || "",
    materials,
    questions,
  };
}

function listPaperFiles(bankDir) {
  const files = [];
  for (const [dir, module] of MODULE_DIRS) {
    const folder = path.join(bankDir, dir);
    if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder)) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      files.push({ file: path.join(dir, name), module, abs: path.join(folder, name) });
    }
  }
  return files;
}

function parseFile(abs, module) {
  const parsed = parseMarkdown(readText(abs), { module });
  parsed.file = abs;
  return parsed;
}

function buildIndex(bankDir) {
  const files = listPaperFiles(bankDir);
  const papers = new Map();
  const questions = [];
  for (const item of files) {
    const parsed = parseFile(item.abs, item.module);
    const key = parsed.paper || item.file;
    if (!papers.has(key)) {
      papers.set(key, {
        title: parsed.paper || path.basename(item.file, ".md"),
        year: parsed.year,
        region: parsed.region,
        modules: [],
        questionCount: 0,
        files: {},
      });
    }
    const paper = papers.get(key);
    if (!paper.modules.includes(item.module)) paper.modules.push(item.module);
    paper.files[item.module] = item.file;
    paper.questionCount += parsed.questions.length;
    for (const q of parsed.questions) {
      questions.push({
        qid: q.qid,
        paper: q.paper,
        year: q.year,
        region: q.region,
        module: q.module,
        type: q.type,
        typeRaw: q.typeRaw,
        no: q.questionNo,
        file: item.file,
        hasImages: q.hasImages,
        materialId: q.materialId || "",
        stem: stripHtml(q.stem).slice(0, 80),
      });
    }
  }
  return {
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: BANK_REPO,
    bankDir,
    paperCount: papers.size,
    questionCount: questions.length,
    papers: [...papers.values()].sort((a, b) => String(b.year).localeCompare(String(a.year)) || a.title.localeCompare(b.title, "zh")),
    questions,
  };
}

function writeIndex(bankDir, outPath) {
  const index = buildIndex(bankDir);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(index) + "\n");
  return index;
}

function loadIndex(indexPath) {
  const file = indexPath || defaultIndexPath();
  if (!fs.existsSync(file)) {
    throw new Error(`还没有题库索引：${file}。请先运行 node tools/tiku.js index`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function search(index, query = {}) {
  const text = (query.text || "").trim().toLowerCase();
  let rows = index.questions || [];
  if (query.qid) rows = rows.filter((q) => String(q.qid) === String(query.qid));
  if (query.year) rows = rows.filter((q) => String(q.year) === String(query.year));
  if (query.region) rows = rows.filter((q) => (q.region || "").includes(query.region));
  if (query.module) rows = rows.filter((q) => (q.module || "").includes(query.module));
  if (query.type) rows = rows.filter((q) => (q.type || "").includes(query.type) || (q.typeRaw || "").includes(query.type));
  if (query.paper) rows = rows.filter((q) => (q.paper || "").includes(query.paper));
  if (query.hasImages != null) rows = rows.filter((q) => !!q.hasImages === !!query.hasImages);
  if (text) {
    rows = rows.filter((q) =>
      (q.stem || "").toLowerCase().includes(text) ||
      (q.paper || "").toLowerCase().includes(text) ||
      String(q.qid).includes(text)
    );
  }
  const limit = query.limit != null ? Number(query.limit) : 50;
  return {
    total: rows.length,
    items: rows.slice(0, Number.isFinite(limit) && limit >= 0 ? limit : 50),
  };
}

function loadFullQuestion(bankDir, entry) {
  const abs = path.join(bankDir, entry.file);
  const parsed = parseFile(abs, entry.module);
  const q = parsed.questions.find((item) => String(item.qid) === String(entry.qid));
  if (!q) throw new Error(`未在 ${entry.file} 中找到 qid ${entry.qid}`);
  const material = parsed.materials.find((m) => m.id === q.materialId) || null;
  return { question: q, material, file: entry.file, bankDir };
}

function copyImages(html, bankDir, mdFile, destDir, urlPrefix) {
  if (!html) return html;
  return html.replace(/(src|href)=["']([^"']+)["']/g, (all, attr, src) => {
    if (!src.includes("90-图片")) return all;
    const mdDir = path.dirname(path.join(bankDir, mdFile));
    const abs = path.resolve(mdDir, src);
    if (!abs.startsWith(path.resolve(bankDir))) return all;
    if (!fs.existsSync(abs)) return all;
    fs.mkdirSync(destDir, { recursive: true });
    const name = path.basename(abs);
    const dest = path.join(destDir, name);
    if (!fs.existsSync(dest)) fs.copyFileSync(abs, dest);
    const url = (urlPrefix || "").replace(/\/?$/, "/") + name;
    return `${attr}="${url}"`;
  });
}

function paperEntries(index, paperName) {
  const items = (index.questions || []).filter((q) => q.paper === paperName);
  if (!items.length) {
    const fuzzy = (index.questions || []).filter((q) => (q.paper || "").includes(paperName));
    return fuzzy;
  }
  return items;
}

function loadPaper(index, bankDir, paperName) {
  const entries = paperEntries(index, paperName);
  if (!entries.length) throw new Error(`题库中没有找到试卷：${paperName}`);
  const byFile = new Map();
  const questions = [];
  const materials = [];
  const seenMat = new Set();
  const officialOrder = ["政治理论", "常识判断", "言语理解", "数量关系", "判断推理", "资料分析"];
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.module)) groups.set(entry.module, []);
    groups.get(entry.module).push(entry);
  }
  const modules = officialOrder.filter((m) => groups.has(m)).concat([...groups.keys()].filter((m) => !officialOrder.includes(m)));
  for (const module of modules) {
    const list = groups.get(module).sort((a, b) => a.no - b.no);
    for (const entry of list) {
      if (!byFile.has(entry.file)) byFile.set(entry.file, parseFile(path.join(bankDir, entry.file), entry.module));
      const parsed = byFile.get(entry.file);
      const q = parsed.questions.find((item) => String(item.qid) === String(entry.qid));
      if (!q) continue;
      if (q.materialId) {
        const mat = parsed.materials.find((m) => m.id === q.materialId);
        if (mat && !seenMat.has(mat.id)) {
          materials.push(mat);
          seenMat.add(mat.id);
        }
      }
      questions.push(q);
    }
  }
  const first = questions[0] || {};
  return {
    paper: first.paper || paperName,
    year: first.year || "",
    region: first.region || "",
    materials,
    questions,
  };
}

function injectSession(template, session) {
  let html = template.replaceAll("{{TITLE}}", session.title || "练习");
  html = html.replace(
    /window\.GONGKAO_SESSION = window\.GONGKAO_SESSION \|\| \{[\s\S]*?\n    \};/,
    () => `window.GONGKAO_SESSION = ${JSON.stringify(session, null, 2)};`
  );
  return html;
}

function prepareSession(paperData, opts = {}) {
  const questions = paperData.questions.map((q) => ({ ...q }));
  const materials = (paperData.materials || []).map((m) => ({ ...m }));
  return {
    id: opts.id || `zhenti-${paperData.year || "paper"}`,
    title: opts.title || paperData.paper,
    mode: opts.mode || "practice",
    exam: paperData.paper,
    paper: paperData.paper,
    year: paperData.year,
    region: paperData.region,
    durationMinutes: opts.durationMinutes != null ? opts.durationMinutes : 0,
    allowReviewBeforeSubmit: false,
    isZhenti: true,
    materials,
    questions,
  };
}

function bundleSessionImages(session, bankDir, index, destDir, urlPrefix) {
  const fileOf = new Map((index.questions || []).map((q) => [String(q.qid), q.file]));
  for (const mat of session.materials || []) {
    const q = (session.questions || []).find((item) => item.materialId === mat.id);
    const file = q ? fileOf.get(String(q.qid)) : null;
    if (file) mat.html = copyImages(mat.html, bankDir, file, destDir, urlPrefix);
  }
  for (const q of session.questions || []) {
    const file = fileOf.get(String(q.qid));
    if (!file) continue;
    q.stem = copyImages(q.stem, bankDir, file, destDir, urlPrefix);
    q.analysis = copyImages(q.analysis, bankDir, file, destDir, urlPrefix);
  }
  return session;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function printJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];
  const bankDir = args.bank ? path.resolve(args.bank) : defaultBankDir();
  const indexPath = args.index ? path.resolve(args.index) : defaultIndexPath();

  if (!cmd || cmd === "help" || args.help) {
    console.log(`用法: node tools/tiku.js <命令>
  index                 扫描题库并生成索引
  search                检索真题（--year --region --module --type --paper --qid --text --limit）
  paper <试卷名>         查看一套真卷的题目清单
  get <qid>             取出一道真题的完整内容
  make --paper <试卷名> --out <html>   生成真题练习页
题库目录默认: ${defaultBankDir()}
索引默认: ${defaultIndexPath()}
来源: ${BANK_REPO}`);
    return 0;
  }

  if (cmd === "index") {
    if (!fs.existsSync(path.join(bankDir, "README.md"))) {
      console.error(`未找到题库：${bankDir}。请先克隆 ${BANK_REPO}`);
      return 1;
    }
    const index = writeIndex(bankDir, indexPath);
    console.log(`已索引 ${index.paperCount} 套试卷、${index.questionCount} 道真题`);
    console.log(`索引文件：${indexPath}`);
    return 0;
  }

  if (cmd === "search") {
    const found = search(loadIndex(indexPath), {
      year: args.year,
      region: args.region,
      module: args.module,
      type: args.type,
      paper: args.paper,
      qid: args.qid,
      text: args.text,
      hasImages: args["has-images"] == null ? null : args["has-images"] === "true" || args["has-images"] === true,
      limit: args.limit,
    });
    printJson(found);
    return 0;
  }

  if (cmd === "paper") {
    const name = args._[1] || args.paper;
    if (!name) {
      console.error("请提供试卷名");
      return 1;
    }
    const index = loadIndex(indexPath);
    const items = paperEntries(index, name);
    printJson({
      total: items.length,
      paper: items[0] ? items[0].paper : name,
      year: items[0] ? items[0].year : "",
      region: items[0] ? items[0].region : "",
      items,
    });
    return items.length ? 0 : 1;
  }

  if (cmd === "get") {
    const qid = args._[1] || args.qid;
    const index = loadIndex(indexPath);
    const entry = (index.questions || []).find((q) => String(q.qid) === String(qid));
    if (!entry) {
      console.error(`未找到 qid ${qid}`);
      return 1;
    }
    printJson(loadFullQuestion(index.bankDir || bankDir, entry));
    return 0;
  }

  if (cmd === "make") {
    const paperName = args.paper || args._[1];
    const out = args.out;
    if (!paperName || !out) {
      console.error("用法: node tools/tiku.js make --paper <试卷名> --out <html> [--duration 120]");
      return 1;
    }
    const index = loadIndex(indexPath);
    const bank = index.bankDir || bankDir;
    const paper = loadPaper(index, bank, paperName);
    const outAbs = path.resolve(out);
    const base = path.basename(outAbs, path.extname(outAbs));
    const destDir = path.join(path.dirname(outAbs), base);
    const urlPrefix = path.basename(destDir);
    let session = prepareSession(paper, {
      id: args.id,
      title: args.title,
      durationMinutes: args.duration != null ? Number(args.duration) : 0,
    });
    session = bundleSessionImages(session, bank, index, destDir, urlPrefix);
    const templatePath = args.template
      ? path.resolve(args.template)
      : path.join(__dirname, "..", "templates", "practice.html");
    const html = injectSession(readText(templatePath), session);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, html);
    console.log(`已生成 ${outAbs}，共 ${session.questions.length} 道真题`);
    return 0;
  }

  console.error(`未知命令：${cmd}`);
  return 1;
}

module.exports = {
  BANK_REPO,
  defaultBankDir,
  defaultIndexPath,
  parseMarkdown,
  parseFile,
  buildIndex,
  writeIndex,
  loadIndex,
  search,
  loadFullQuestion,
  loadPaper,
  prepareSession,
  bundleSessionImages,
  injectSession,
  classifyType,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}
