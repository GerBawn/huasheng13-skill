"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const tiku = require("../tools/tiku.js");

const VERBAL_MD = `---
试卷: "测试言语卷"
年份: "2025"
地区: "国考"
模块: "言语理解与表达"
---

# 测试言语卷

## 材料 1

<p>这是篇章材料一，关于农作物种植制度。</p>

### 第 1 题　<sub>qid 1001 · 语句表达</sub>

下面这段文字最适合填入文中哪个位置?

- **A**. ①和②之间
- **B**. ②和③之间　✅
- **C**. ③和④之间
- **D**. ⑥之后

**答案**：B

**官方解析**

解析一。

---

### 第 2 题　<sub>qid 1002 · 片段阅读</sub>

这篇文章意在说明：

- **A**. 甲　✅
- **B**. 乙
- **C**. 丙
- **D**. 丁

**答案**：A

**官方解析**

解析二。

---

## 材料 2

<p>这是篇章材料二，关于舍勒绿与砷绿。</p>

### 第 6 题　<sub>qid 1006 · 语句表达</sub>

填入第⑥段中画横线部分最恰当的一句是：

- **A**. 甲
- **B**. 乙　✅
- **C**. 丙
- **D**. 丁

**答案**：B

**官方解析**

解析六。

---

### 第 10 题　<sub>qid 1010 · 片段阅读</sub>

根据文意，下列说法正确的是：

- **A**. 甲　✅
- **B**. 乙
- **C**. 丙
- **D**. 丁

**答案**：A

**官方解析**

解析十。

---

### 第 11 题　<sub>qid 1011 · 逻辑填空</sub>

如今，一批年轻的年画传承人涌现出来。这些年轻人开始有了清醒的文化自觉，并不__________，急于进入市场大潮。

填入画横线部分最恰当的一项是：

- **A**. 急功近利　✅
- **B**. 随波逐流
- **C**. 好高骛远
- **D**. 按部就班

**答案**：A

**官方解析**

解析十一。

---

### 第 21 题　<sub>qid 1021 · 片段阅读</sub>

世界第四大岛马达加斯加位于非洲东南部，地质史上历经数次漫长的岩浆活动，形成独特的天然矿石博物馆。经过仔细勘探，宝石学家又发现了一种全新的宝石。

这段文字意在说明：

- **A**. 宝石　✅
- **B**. 岛屿
- **C**. 岩浆
- **D**. 博物馆

**答案**：A

**官方解析**

解析二十一。
`;

const DATA_MD = `---
试卷: "测试资料卷"
年份: "2025"
地区: "国考"
模块: "资料分析"
---

# 测试资料卷

## 材料 1

<p>截至2023年末，我国集成电路布图设计登记累计申请93147件。</p>

### 第 1 题　<sub>qid 2001 · 综合</sub>

截至2014年末，申请量在哪个范围？

- **A**. 0.8万-1.5万件之间　✅
- **B**. 不到0.8万件
- **C**. 1.5万-2.2万件之间
- **D**. 超过2.2万件

**答案**：A

**官方解析**

解析1。

### 第 2 题　<sub>qid 2002 · 增长</sub>

如2024年5-12月水平相同，则将比上年：

- **A**. 下降不到20%　✅
- **B**. 下降20%以上
- **C**. 上升不到20%
- **D**. 上升20%以上

**答案**：A

**官方解析**

解析2。

### 第 3 题　<sub>qid 2003 · 增长</sub>

同比增长约：

- **A**. 10%　✅
- **B**. 20%
- **C**. 30%
- **D**. 40%

**答案**：A

**官方解析**

解析3。

### 第 4 题　<sub>qid 2004 · 综合</sub>

能够从上述资料推出的是：

- **A**. 甲　✅
- **B**. 乙
- **C**. 丙
- **D**. 丁

**答案**：A

**官方解析**

解析4。

### 第 5 题　<sub>qid 2005 · 增长</sub>

增长量最大的是：

- **A**. 甲　✅
- **B**. 乙
- **C**. 丙
- **D**. 丁

**答案**：A

**官方解析**

解析5。

## 材料 2

<p>第二篇资料，关于进出口。</p>

### 第 6 题　<sub>qid 2006 · 综合</sub>

下列说法正确的是：

- **A**. 甲　✅
- **B**. 乙
- **C**. 丙
- **D**. 丁

**答案**：A

**官方解析**

解析6。

### 第 7 题　<sub>qid 2007 · 比重</sub>

比重约是：

- **A**. 10%　✅
- **B**. 20%
- **C**. 30%
- **D**. 40%

**答案**：A

**官方解析**

解析7。

### 第 8 题　<sub>qid 2008 · 综合</sub>

能够推出的是：

- **A**. 甲　✅
- **B**. 乙
- **C**. 丙
- **D**. 丁

**答案**：A

**官方解析**

解析8。

### 第 9 题　<sub>qid 2009 · 综合</sub>

以下正确的是：

- **A**. 甲　✅
- **B**. 乙
- **C**. 丙
- **D**. 丁

**答案**：A

**官方解析**

解析9。

### 第 10 题　<sub>qid 2010 · 平均数</sub>

平均数约为：

- **A**. 1　✅
- **B**. 2
- **C**. 3
- **D**. 4

**答案**：A

**官方解析**

解析10。
`;

describe("questionBelongsToMaterial", () => {
  it("keeps 资料分析 questions on the current material", () => {
    assert.equal(tiku.questionBelongsToMaterial("截至2014年末，申请量在哪个范围？", "资料分析"), true);
    assert.equal(tiku.questionBelongsToMaterial("能够从上述资料推出的是：", "资料分析"), true);
  });

  it("keeps short or article-referencing 言语 questions", () => {
    assert.equal(tiku.questionBelongsToMaterial("这篇文章意在说明：", "言语理解"), true);
    assert.equal(tiku.questionBelongsToMaterial("下面这段文字最适合填入文中哪个位置？\\n一段要插入的文字。", "言语理解"), true);
    assert.equal(tiku.questionBelongsToMaterial("填入第⑥段中画横线部分最恰当的一句是：", "言语理解"), true);
  });

  it("clears self-contained 逻辑填空 and 片段阅读", () => {
    const fill = "如今，一批年轻的年画传承人涌现出来。这些年轻人开始有了清醒的文化自觉，并不__________，急于进入市场大潮。\\n填入画横线部分最恰当的一项是：";
    assert.equal(tiku.questionBelongsToMaterial(fill, "言语理解"), false);
    const passage = "世界第四大岛马达加斯加位于非洲东南部，地质史上历经数次漫长的岩浆活动，形成独特的天然矿石博物馆。经过仔细勘探，宝石学家又发现了一种全新的宝石。\\n这段文字意在说明：";
    assert.equal(tiku.questionBelongsToMaterial(passage, "言语理解"), false);
  });
});

describe("parseMarkdown material scope", () => {
  it("attaches 言语篇章材料 only to the questions that belong to that passage", () => {
    const parsed = tiku.parseMarkdown(VERBAL_MD, { module: "言语理解" });
    assert.equal(parsed.materials.length, 2);
    const byNo = Object.fromEntries(parsed.questions.map((q) => [q.questionNo, q]));
    assert.equal(byNo[1].materialId, parsed.materials[0].id);
    assert.equal(byNo[2].materialId, parsed.materials[0].id);
    assert.equal(byNo[6].materialId, parsed.materials[1].id);
    assert.equal(byNo[10].materialId, parsed.materials[1].id);
    assert.equal(byNo[11].materialId, "");
    assert.equal(byNo[21].materialId, "");
    assert.ok(parsed.materials[1].html.includes("舍勒绿"));
  });

  it("keeps 资料分析 as one material for each following block of questions", () => {
    const parsed = tiku.parseMarkdown(DATA_MD, { module: "资料分析" });
    assert.equal(parsed.materials.length, 2);
    const byNo = Object.fromEntries(parsed.questions.map((q) => [q.questionNo, q]));
    for (let n = 1; n <= 5; n++) assert.equal(byNo[n].materialId, parsed.materials[0].id);
    for (let n = 6; n <= 10; n++) assert.equal(byNo[n].materialId, parsed.materials[1].id);
    assert.equal(parsed.questions.every((q) => q.materialId), true);
  });
});

describe("2025 国考副省级 live papers", () => {
  const bank = "/home/box/data/xingcezhenti";
  const verbalFile = path.join(bank, "03-言语理解与表达", "2025年国家公务员录用考试《行测》题（副省级网友回忆版）.md");
  const dataFile = path.join(bank, "06-资料分析", "2025年国家公务员录用考试《行测》题（副省级网友回忆版）.md");

  it("verbal 材料 1 = 题 1–5, 材料 2 = 题 6–10, later questions have no material", { skip: !fs.existsSync(verbalFile) }, () => {
    const parsed = tiku.parseMarkdown(fs.readFileSync(verbalFile, "utf8"), { module: "言语理解" });
    const byNo = Object.fromEntries(parsed.questions.map((q) => [q.questionNo, q]));
    const m1 = parsed.materials.find((m) => m.no === 1);
    const m2 = parsed.materials.find((m) => m.no === 2);
    assert.ok(m1 && m2);
    assert.ok(/舍勒绿|砷绿|砷/.test(m2.html));
    for (let n = 1; n <= 5; n++) assert.equal(byNo[n].materialId, m1.id, "q" + n);
    for (let n = 6; n <= 10; n++) assert.equal(byNo[n].materialId, m2.id, "q" + n);
    for (let n = 11; n <= 30; n++) assert.equal(byNo[n].materialId, "", "q" + n + " should not inherit 材料 2");
  });

  it("资料分析 stays 4 materials × 5 questions", { skip: !fs.existsSync(dataFile) }, () => {
    const parsed = tiku.parseMarkdown(fs.readFileSync(dataFile, "utf8"), { module: "资料分析" });
    assert.equal(parsed.materials.length, 4);
    assert.equal(parsed.questions.length, 20);
    for (const [i, mat] of parsed.materials.entries()) {
      const start = i * 5 + 1;
      const nos = parsed.questions.filter((q) => q.materialId === mat.id).map((q) => q.questionNo);
      assert.deepEqual(nos, [start, start + 1, start + 2, start + 3, start + 4]);
    }
  });
});
