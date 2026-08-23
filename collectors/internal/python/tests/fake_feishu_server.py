from __future__ import annotations

import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def message(message_id: str, create_time: str, sender: str, msg_type: str, content: dict):
    return {
        "message_id": message_id,
        "chat_id": "oc_demo",
        "msg_type": msg_type,
        "create_time": create_time,
        "update_time": create_time,
        "deleted": False,
        "updated": False,
        "sender": {"id": sender, "sender_type": "user"},
        "body": {"content": json.dumps(content, ensure_ascii=False)},
    }


FIRST_PAGE = [
    message("om_demo_1", "1787277600000", "ou_zhang", "text", {"text": "项目历史资料开始整理。"}),
    message("om_demo_2", "1787277660000", "ou_li", "image", {"image_key": "img_demo", "name": "参考图.png"}),
    message("om_demo_3", "1787277720000", "ou_zhang", "text", {"text": "图片已经补充，请继续核对附件。"}),
]
SECOND_PAGE = [
    message("om_demo_4", "1787277780000", "ou_li", "file", {"file_key": "file_demo", "file_name": "项目说明.txt"}),
    message("om_demo_5", "1787277840000", "ou_zhang", "text", {"text": "历史记录采集完成。"}),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "DLRMockFeishu/1.0"

    def log_message(self, _format: str, *_args) -> None:
        return

    def send_json(self, value: dict, status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        if self.path != "/open-apis/auth/v3/tenant_access_token/internal":
            self.send_json({"code": 404, "msg": "not found"}, 404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        if payload.get("app_id") != "cli_demo" or payload.get("app_secret") != "demo_secret":
            self.send_json({"code": 10003, "msg": "invalid app credentials"})
            return
        self.send_json({"code": 0, "msg": "ok", "tenant_access_token": "t-demo", "expire": 7200})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if self.headers.get("Authorization") != "Bearer t-demo":
            self.send_json({"code": 99991663, "msg": "invalid token"}, 401)
            return
        if parsed.path == "/open-apis/im/v1/chats":
            self.send_json({
                "code": 0,
                "data": {
                    "items": [
                        {
                            "chat_id": "oc_demo", "name": "DLR 项目演示群", "description": "端到端验收群",
                            "chat_mode": "group", "chat_status": "normal", "external": False,
                            "owner_id": "ou_zhang",
                        },
                        {
                            "chat_id": "oc_archive", "name": "历史归档群", "description": "第二个可选群",
                            "chat_mode": "group", "chat_status": "normal", "external": False,
                            "owner_id": "ou_zhang",
                        },
                    ],
                    "has_more": False,
                },
            })
            return
        if parsed.path == "/open-apis/im/v1/chats/oc_demo/members":
            self.send_json({
                "code": 0,
                "data": {
                    "items": [
                        {"member_id": "ou_zhang", "name": "张三"},
                        {"member_id": "ou_li", "name": "李四"},
                    ],
                    "has_more": False,
                },
            })
            return
        if parsed.path == "/open-apis/im/v1/messages":
            query = parse_qs(parsed.query)
            token = (query.get("page_token") or [""])[0]
            items = SECOND_PAGE if token == "next" else FIRST_PAGE
            start_ms = int((query.get("start_time") or ["0"])[0]) * 1000
            end_ms = int((query.get("end_time") or ["9999999999999"])[0]) * 1000
            items = [item for item in items if start_ms <= int(item["create_time"]) < end_ms]
            self.send_json({
                "code": 0,
                "data": {
                    "items": items,
                    "page_token": "" if token == "next" else "next",
                    "has_more": token != "next",
                },
            })
            return
        if parsed.path.endswith("/resources/img_demo"):
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Disposition", "filename*=UTF-8''reference.png")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
            return
        if parsed.path.endswith("/resources/file_demo"):
            payload = "这是端到端测试附件。".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", "filename*=UTF-8''project-notes.txt")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_json({"code": 404, "msg": "not found"}, 404)


if __name__ == "__main__":
    port = int(os.getenv("MOCK_FEISHU_PORT", "4010"))
    print(f"mock-feishu-ready:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
