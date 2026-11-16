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
            self._send(200, {
                "ok": True,
                "dataDir": str(root),
                "sessionCount": len(sessions),
                "port": self.server.server_port,  # type: ignore[attr-defined]
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

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.data_root = root
    print(f"公考记录服务已启动：http://127.0.0.1:{args.port}")
    print(f"记录目录：{root}")
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
