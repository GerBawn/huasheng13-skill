#!/usr/bin/env python3
"""本机公考作答记录服务：只监听 127.0.0.1，把交卷记录写入「公考练习记录」。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_PORT = 17813
MAX_BODY = 2 * 1024 * 1024
SAFE_ID = re.compile(r"[^\w\-]+")


def data_dir() -> Path:
    override = os.environ.get("GONGKAO_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / "Documents" / "公考练习记录").resolve()


def ensure_dirs(root: Path) -> None:
    (root / "sessions").mkdir(parents=True, exist_ok=True)
    (root / "pages").mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_token(value: str, fallback: str) -> str:
    token = SAFE_ID.sub("", str(value or ""))
    return token or fallback


def session_filename(record: dict) -> str:
    sid = safe_token(record.get("sessionId") or "", "practice")
    started = record.get("startedAt") or record.get("savedAt") or now_iso()
    ts = re.sub(r"[^\d]", "", str(started))[:14] or datetime.now().strftime("%Y%m%d%H%M%S")
    return f"gongkao-session-{sid}-{ts}.json"


def write_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_sessions(root: Path) -> list[tuple[Path, dict]]:
    items: list[tuple[Path, dict]] = []
    for path in sorted((root / "sessions").glob("gongkao-session-*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict):
            items.append((path, data))
    items.sort(key=lambda pair: pair[1].get("savedAt") or pair[1].get("startedAt") or pair[0].name)
    return items


def bump(bucket: dict, key: str, correct) -> None:
    name = key or "未分类"
    row = bucket.setdefault(name, {"total": 0, "correct": 0})
    row["total"] += 1
    if correct:
        row["correct"] += 1


def cuoti_entry(last: dict, attempts: list[dict], essay: bool) -> dict:
    wrongs = [a for a in attempts if a.get("correct") is False]
    return {
        "id": last.get("id") or "",
        "module": last.get("module") or "",
        "type": last.get("type") or "",
        "kind": last.get("kind") or ("essay" if essay else "choice"),
        "stem": last.get("stem") or "",
        "options": last.get("options") or [],
        "correctAnswer": last.get("correctAnswer") or "",
        "analysis": last.get("analysis") or "",
        "source": last.get("source") or "",
        "lastUserAnswer": last.get("userAnswer") or "",
        "wrongCount": len(wrongs),
        "lastWrongAt": (wrongs[-1].get("savedAt") or "") if wrongs else "",
        "lastAnsweredAt": attempts[-1].get("savedAt") or "",
        "attempts": len(attempts),
    }


def rebuild(root: Path) -> tuple[dict, dict]:
    history: dict[str, list[dict]] = {}
    by_module: dict = {}
    by_type: dict = {}
    session_rows = []

    for path, rec in load_sessions(root):
        summary = rec.get("summary") or {}
        saved_at = rec.get("savedAt") or ""
        session_rows.append({
            "file": f"sessions/{path.name}",
            "sessionId": rec.get("sessionId") or "",
            "title": rec.get("title") or "",
            "savedAt": saved_at,
            "accuracy": summary.get("accuracy"),
            "usedSeconds": rec.get("usedSeconds") or 0,
            "total": summary.get("total"),
            "correct": summary.get("correct"),
        })
        for item in rec.get("items") or []:
            qid = str(item.get("id") or "")
            if not qid:
                continue
            attempt = dict(item)
            attempt["savedAt"] = saved_at
            attempt["sessionId"] = rec.get("sessionId") or ""
            history.setdefault(qid, []).append(attempt)
            if item.get("correct") is None:
                continue
            bump(by_module, item.get("module") or "", item.get("correct"))
            bump(by_type, item.get("type") or "", item.get("correct"))

    mastered: list[str] = []
    cuoti_items: list[dict] = []
    essays: list[dict] = []
    for qid, attempts in history.items():
        last = attempts[-1]
        if last.get("correct") is None:
            if last.get("userAnswer"):
                essays.append(cuoti_entry(last, attempts, True))
            continue
        scored = [a for a in attempts if a.get("correct") is not None]
        if len(scored) >= 2 and scored[-1]["correct"] and scored[-2]["correct"]:
            mastered.append(qid)
            continue
        if any(a.get("correct") is False for a in scored):
            cuoti_items.append(cuoti_entry(last, attempts, False))

    updated = now_iso()
    progress = {
        "updatedAt": updated,
        "sessions": session_rows,
        "byModule": by_module,
        "byType": by_type,
        "masteredIds": mastered,
    }
    cuoti = {
        "updatedAt": updated,
        "items": cuoti_items,
        "essays": essays,
    }
    return progress, cuoti


def persist_progress(root: Path) -> tuple[dict, dict]:
    progress, cuoti = rebuild(root)
    write_json(root / "progress.json", progress)
    write_json(root / "cuoti.json", cuoti)
    return progress, cuoti


def validate_record(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("记录必须是 JSON 对象")
    if not isinstance(payload.get("items"), list):
        raise ValueError("记录缺少 items")
    payload = dict(payload)
    payload["savedAt"] = payload.get("savedAt") or now_iso()
    payload["sessionId"] = payload.get("sessionId") or "practice"
    return payload



TAXONOMY = [
    ("常识判断", ["政治", "经济", "法律", "人文历史", "科技生活", "地理国情"]),
    ("言语理解", ["逻辑填空", "中心理解", "细节判断", "标题填入", "语句排序", "语句填空", "接语理解"]),
    ("数量关系", ["工程问题", "行程问题", "利润问题", "排列组合", "概率", "容斥", "最值问题", "几何问题", "年龄问题", "比例问题"]),
    ("判断推理", ["图形推理", "定义判断", "类比推理", "翻译推理", "加强削弱", "前提假设", "真假推理", "日常结论"]),
    ("资料分析", ["增长量", "增长率", "比重", "两期比重", "平均数", "平均数增长量", "基期平均数", "倍数", "综合分析"]),
    ("申论", ["归纳概括", "综合分析", "提出对策", "贯彻执行", "申发论述"]),
]

MODULE_ALIASES = {
    "资料": "资料分析",
    "资料分析": "资料分析",
    "数量": "数量关系",
    "数量关系": "数量关系",
    "言语": "言语理解",
    "言语理解": "言语理解",
    "判断": "判断推理",
    "判断推理": "判断推理",
    "常识": "常识判断",
    "常识判断": "常识判断",
    "申论": "申论",
}

TYPE_ALIASES = {
    "两集合容斥": "容斥",
    "容斥问题": "容斥",
    "类比": "类比推理",
    "前提假设/搭桥": "前提假设",
    "搭桥": "前提假设",
    "比重升降": "两期比重",
    "两期比重升降": "两期比重",
    "增长": "增长量",
    "工程": "工程问题",
    "行程": "行程问题",
    "利润": "利润问题",
    "几何": "几何问题",
    "年龄": "年龄问题",
    "比例": "比例问题",
    "最值": "最值问题",
    "图形": "图形推理",
    "定义": "定义判断",
    "翻译": "翻译推理",
    "加强": "加强削弱",
    "削弱": "加强削弱",
    "公文": "贯彻执行",
    "大作文": "申发论述",
    "作文": "申发论述",
}


def canon_module(name: str) -> str:
    raw = (name or "").strip() or "未分类"
    if raw in MODULE_ALIASES:
        return MODULE_ALIASES[raw]
    for official in MODULE_ALIASES.values():
        if official in raw or raw in official:
            return official
    return raw


def module_types(module: str) -> list[str]:
    for name, types in TAXONOMY:
        if name == module:
            return list(types)
    return []


def canon_type(name: str, module: str) -> str:
    raw = (name or "").strip() or "未分类"
    if raw in TYPE_ALIASES:
        return TYPE_ALIASES[raw]
    official = module_types(module)
    if raw in official:
        return raw
    matches = [item for item in official if item in raw or (len(raw) >= 2 and raw in item)]
    if matches:
        return max(matches, key=len)
    return raw


def mastery_level(total: int, correct: int, cuoti_count: int) -> str:
    if total <= 0:
        return "未练"
    accuracy = correct / total
    if total >= 3 and accuracy >= 0.8 and cuoti_count == 0:
        return "掌握"
    if (total >= 3 and accuracy < 0.6) or cuoti_count >= 2 or (cuoti_count >= 1 and accuracy < 0.6):
        return "薄弱"
    return "一般"


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    return data if isinstance(data, dict) else default


def build_map(root: Path) -> dict:
    progress, cuoti = persist_progress(root)
    stats: dict[tuple[str, str], dict] = {}

    def ensure(module: str, typ: str) -> dict:
        key = (module, typ)
        row = stats.get(key)
        if row is None:
            row = {"module": module, "type": typ, "total": 0, "correct": 0, "cuotiCount": 0}
            stats[key] = row
        return row

    for name, types in TAXONOMY:
        for typ in types:
            ensure(name, typ)

    for path, rec in load_sessions(root):
        for item in rec.get("items") or []:
            if item.get("correct") is None:
                continue
            module = canon_module(item.get("module") or "")
            typ = canon_type(item.get("type") or "", module)
            row = ensure(module, typ)
            row["total"] += 1
            if item.get("correct"):
                row["correct"] += 1

    for item in (cuoti.get("items") or []):
        module = canon_module(item.get("module") or "")
        typ = canon_type(item.get("type") or "", module)
        ensure(module, typ)["cuotiCount"] += 1

    modules: list[dict] = []
    seen_modules = {name for name, _ in TAXONOMY}
    ordered_modules = [name for name, _ in TAXONOMY]
    for module, _typ in stats:
        if module not in seen_modules:
            ordered_modules.append(module)
            seen_modules.add(module)

    level_counts = {"未练": 0, "薄弱": 0, "一般": 0, "掌握": 0}
    practiced_types = 0
    for module in ordered_modules:
        type_names = module_types(module)
        extras = [typ for (mod, typ) in stats if mod == module and typ not in type_names]
        type_rows = []
        m_total = m_correct = m_cuoti = 0
        for typ in type_names + extras:
            row = stats.get((module, typ), {"total": 0, "correct": 0, "cuotiCount": 0})
            total = int(row.get("total") or 0)
            correct = int(row.get("correct") or 0)
            cuoti_count = int(row.get("cuotiCount") or 0)
            accuracy = (correct / total) if total else 0
            level = mastery_level(total, correct, cuoti_count)
            level_counts[level] = level_counts.get(level, 0) + 1
            if total:
                practiced_types += 1
            m_total += total
            m_correct += correct
            m_cuoti += cuoti_count
            type_rows.append({
                "name": typ,
                "total": total,
                "correct": correct,
                "accuracy": round(accuracy, 3),
                "cuotiCount": cuoti_count,
                "level": level,
            })
        m_acc = (m_correct / m_total) if m_total else 0
        modules.append({
            "name": module,
            "total": m_total,
            "correct": m_correct,
            "accuracy": round(m_acc, 3),
            "cuotiCount": m_cuoti,
            "level": mastery_level(m_total, m_correct, m_cuoti),
            "types": type_rows,
        })

    return {
        "updatedAt": progress.get("updatedAt") or now_iso(),
        "summary": {
            "sessionCount": len(progress.get("sessions") or []),
            "practicedTypes": practiced_types,
            "cuotiCount": len(cuoti.get("items") or []),
            "byLevel": level_counts,
        },
        "modules": modules,
    }


def map_page_html() -> str:
    here = Path(__file__).resolve().parent
    for candidate in (here / "map.html", here.parent / "templates" / "map.html"):
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8")
    return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='UTF-8'><title>能力地图</title></head><body><p>缺少 map.html。</p></body></html>"


def probe(port: int):
    from urllib.request import urlopen
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "GongkaoRecord/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[公考记录] {self.address_string()} {fmt % args}\n")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _send(self, code: int, payload: dict, ctype: str = "application/json; charset=utf-8") -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        root: Path = self.server.data_root  # type: ignore[attr-defined]
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._send_bytes(200, index_page(root).encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/api/health":
            sessions = list((root / "sessions").glob("gongkao-session-*.json"))
            port = self.server.server_port  # type: ignore[attr-defined]
            self._send(200, {
                "ok": True,
                "dataDir": str(root),
                "sessionCount": len(sessions),
                "port": port,
                "mapUrl": f"http://127.0.0.1:{port}/map",
            })
            return
        if path == "/api/progress":
            persist_progress(root)
            progress = json.loads((root / "progress.json").read_text(encoding="utf-8"))
            self._send(200, {"ok": True, "progress": progress})
            return
        if path == "/api/cuoti":
            persist_progress(root)
            cuoti = json.loads((root / "cuoti.json").read_text(encoding="utf-8"))
            self._send(200, {"ok": True, "cuoti": cuoti})
            return
        if path == "/api/map":
            self._send(200, {"ok": True, "map": build_map(root)})
            return
        if path in ("/map", "/map.html"):
            self._send_bytes(200, map_page_html().encode("utf-8"), "text/html; charset=utf-8")
            return
        if path.startswith("/pages/"):
            rel = path[len("/pages/"):]
            target = (root / "pages" / rel).resolve()
            pages = (root / "pages").resolve()
            if pages not in target.parents and target != pages:
                self._send(403, {"ok": False, "error": "路径不允许"})
                return
            if not target.is_file():
                self._send(404, {"ok": False, "error": "页面不存在"})
                return
            ctype = "text/html; charset=utf-8" if target.suffix.lower() in {".html", ".htm"} else "application/octet-stream"
            self._send_bytes(200, target.read_bytes(), ctype)
            return
        self._send(404, {"ok": False, "error": "未找到接口"})

    def do_POST(self) -> None:
        root: Path = self.server.data_root  # type: ignore[attr-defined]
        path = urlparse(self.path).path
        if path != "/api/sessions":
            self._send(404, {"ok": False, "error": "未找到接口"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send(400, {"ok": False, "error": "请求体无效或过大"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            record = validate_record(payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"ok": False, "error": "JSON 无法解析"})
            return
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
            return
        filename = session_filename(record)
        dest = root / "sessions" / filename
        write_json(dest, record)
        progress, cuoti = persist_progress(root)
        self._send(200, {
            "ok": True,
            "file": f"sessions/{filename}",
            "dataDir": str(root),
            "summary": record.get("summary") or {},
            "progress": progress,
            "cuotiCount": len(cuoti.get("items") or []),
        })


def index_page(root: Path) -> str:
    pages = sorted((root / "pages").glob("*.html"), key=lambda p: p.stat().st_mtime, reverse=True)
    links = "\n".join(
        f'<li><a href="/pages/{p.name}">{p.name}</a></li>' for p in pages
    ) or "<li>还没有练习页</li>"
    sessions = list((root / "sessions").glob("gongkao-session-*.json"))
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>公考记录服务</title>
  <style>
    body {{ font: 16px/1.6 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1f1b16; background: #f6f3ee; }}
    a {{ color: #2d4a6e; }}
  </style>
</head>
<body>
  <h1>公考记录服务已启动</h1>
  <p>记录目录：<code>{root}</code></p>
  <p>已保存场次：{len(sessions)}</p>
  <p><a href="/map">打开能力地图</a></p>
  <h2>练习页</h2>
  <ul>{links}</ul>
  <p>交卷会自动写入 <code>sessions/</code>，并更新 <code>progress.json</code> 和 <code>cuoti.json</code>。</p>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="本机公考作答记录服务")
    parser.add_argument("--port", type=int, default=int(os.environ.get("GONGKAO_PORT") or DEFAULT_PORT))
    parser.add_argument("--data-dir", default=None)
    args = parser.parse_args()
    root = Path(args.data_dir).expanduser().resolve() if args.data_dir else data_dir()
    ensure_dirs(root)
    persist_progress(root)

    existing = probe(args.port)
    if existing and existing.get("ok"):
        print(f"公考记录服务已在运行：http://127.0.0.1:{args.port}")
        print(f"记录目录：{existing.get('dataDir') or root}")
        print(f"能力地图：http://127.0.0.1:{args.port}/map")
        return 0

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        print(f"无法监听 127.0.0.1:{args.port}：{exc}", file=sys.stderr)
        return 1
    httpd.data_root = root
    print(f"公考记录服务已启动：http://127.0.0.1:{args.port}")
    print(f"记录目录：{root}")
    print(f"能力地图：http://127.0.0.1:{args.port}/map")
    print("只监听本机。按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
