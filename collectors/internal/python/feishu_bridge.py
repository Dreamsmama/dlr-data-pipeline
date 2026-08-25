from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, unquote
from urllib.request import Request, urlopen


API_BASE = os.getenv("FEISHU_API_BASE_URL", "https://open.feishu.cn/open-apis").rstrip("/")
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}


class FeishuError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)


def read_payload() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("未收到任务输入")
    payload = json.loads(line)
    if not isinstance(payload, dict):
        raise RuntimeError("任务输入必须是 JSON 对象")
    return payload


def retry_delay(attempt: int, retry_after: str | None = None) -> float:
    if retry_after:
        try:
            return min(float(retry_after), 30.0)
        except ValueError:
            pass
    return min(2**attempt, 10)


def json_from_bytes(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


class FeishuClient:
    def __init__(self, app_id: str, app_secret: str, base_url: str = API_BASE) -> None:
        self.app_id = app_id
        self.app_secret = app_secret
        self.base_url = base_url.rstrip("/")
        self._token = ""
        self._expires_at = 0.0

    def request_json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
        authenticated: bool = True,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        clean_params = {key: value for key, value in (params or {}).items() if value not in (None, "")}
        if clean_params:
            url = f"{url}?{urlencode(clean_params)}"
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.tenant_access_token()}"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None

        for attempt in range(4):
            try:
                with urlopen(Request(url, data=data, headers=headers, method=method), timeout=45) as response:
                    result = json_from_bytes(response.read())
                    if not isinstance(result, dict):
                        raise FeishuError("飞书返回了非 JSON 响应")
                    if result.get("code", 0) != 0:
                        raise FeishuError(
                            f"飞书 API 错误 {result.get('code')}: {result.get('msg', 'unknown')}",
                            status=getattr(response, "status", None),
                        )
                    return result
            except HTTPError as error:
                raw = error.read()
                detail = json_from_bytes(raw)
                message = detail.get("msg") if isinstance(detail, dict) else raw[:300].decode("utf-8", "replace")
                if error.code in RETRYABLE_HTTP_STATUS and attempt < 3:
                    time.sleep(retry_delay(attempt, error.headers.get("Retry-After")))
                    continue
                raise FeishuError(f"飞书 HTTP {error.code}: {message}", status=error.code) from error
            except URLError as error:
                if attempt < 3:
                    time.sleep(retry_delay(attempt))
                    continue
                raise FeishuError(f"无法连接飞书开放平台：{error.reason}") from error
        raise AssertionError("unreachable")

    def tenant_access_token(self) -> str:
        if self._token and time.time() < self._expires_at - 60:
            return self._token
        result = self.request_json(
            "POST",
            "/auth/v3/tenant_access_token/internal",
            payload={"app_id": self.app_id, "app_secret": self.app_secret},
            authenticated=False,
        )
        token = str(result.get("tenant_access_token") or "")
        if not token:
            raise FeishuError("飞书响应中缺少 tenant_access_token")
        self._token = token
        self._expires_at = time.time() + int(result.get("expire") or 7200)
        return token

    def list_chats(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page_token = ""
        while True:
            result = self.request_json(
                "GET",
                "/im/v1/chats",
                params={"page_size": 100, "page_token": page_token},
            )
            data = result.get("data") or {}
            items.extend(data.get("items") or [])
            if not data.get("has_more"):
                return items
            next_token = str(data.get("page_token") or "")
            if not next_token or next_token == page_token:
                raise FeishuError("群列表分页标记异常")
            page_token = next_token

    def list_members(self, chat_id: str) -> dict[str, str]:
        members: dict[str, str] = {}
        page_token = ""
        while True:
            result = self.request_json(
                "GET",
                f"/im/v1/chats/{quote(chat_id, safe='')}/members",
                params={"member_id_type": "open_id", "page_size": 100, "page_token": page_token},
            )
            data = result.get("data") or {}
            for item in data.get("items") or []:
                member_id = str(item.get("member_id") or "")
                name = str(item.get("name") or "").strip()
                if member_id and name:
                    members[member_id] = name
            if not data.get("has_more"):
                return members
            next_token = str(data.get("page_token") or "")
            if not next_token or next_token == page_token:
                raise FeishuError("群成员分页标记异常")
            page_token = next_token

    def list_messages(
        self,
        chat_id: str,
        page_token: str,
        start_time: int,
        end_time_exclusive: int,
    ) -> tuple[list[dict[str, Any]], str, bool]:
        result = self.request_json(
            "GET",
            "/im/v1/messages",
            params={
                "container_id_type": "chat",
                "container_id": chat_id,
                "sort_type": "ByCreateTimeAsc",
                "start_time": start_time,
                "end_time": end_time_exclusive,
                "page_size": 50,
                "page_token": page_token,
            },
        )
        data = result.get("data") or {}
        return data.get("items") or [], str(data.get("page_token") or ""), bool(data.get("has_more"))

    def open_resource(self, message_id: str, file_key: str, resource_type: str):
        url = (
            f"{self.base_url}/im/v1/messages/{quote(message_id, safe='')}/resources/"
            f"{quote(file_key, safe='')}?{urlencode({'type': resource_type})}"
        )
        headers = {"Authorization": f"Bearer {self.tenant_access_token()}"}
        for attempt in range(4):
            try:
                return urlopen(Request(url, headers=headers, method="GET"), timeout=90)
            except HTTPError as error:
                raw = error.read()
                detail = json_from_bytes(raw)
                message = detail.get("msg") if isinstance(detail, dict) else raw[:300].decode("utf-8", "replace")
                if error.code in RETRYABLE_HTTP_STATUS and attempt < 3:
                    time.sleep(retry_delay(attempt, error.headers.get("Retry-After")))
                    continue
                raise FeishuError(f"附件 HTTP {error.code}: {message}", status=error.code) from error
            except URLError as error:
                if attempt < 3:
                    time.sleep(retry_delay(attempt))
                    continue
                raise FeishuError(f"附件网络错误：{error.reason}") from error
        raise AssertionError("unreachable")


def parse_content(message: dict[str, Any]) -> Any:
    body = message.get("body") or {}
    raw = body.get("content") if isinstance(body, dict) else None
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(filter(None, (content_to_text(item) for item in content))).strip()
    if not isinstance(content, dict):
        return "" if content is None else str(content)
    if isinstance(content.get("text"), str):
        return content["text"]
    parts: list[str] = []
    for key in ("title", "file_name", "name", "href"):
        value = content.get(key)
        if isinstance(value, str) and value:
            parts.append(value)
    for key, value in content.items():
        if key in {"title", "file_name", "name", "href", "image_key", "file_key"}:
            continue
        if isinstance(value, (dict, list)):
            nested = content_to_text(value)
            if nested:
                parts.append(nested)
    unique_parts: list[str] = []
    seen: set[str] = set()
    for part in parts:
        normalized = " ".join(part.split())
        identity = normalized.casefold()
        if normalized and identity not in seen:
            seen.add(identity)
            unique_parts.append(normalized)
    return " ".join(unique_parts)


def resolve_mentions(
    text: str,
    mentions: Any,
    members: dict[str, str] | None = None,
) -> str:
    if not text or not isinstance(mentions, list):
        return text
    member_names = members or {}
    replacements: dict[str, str] = {}
    for mention in mentions:
        if not isinstance(mention, dict):
            continue
        raw_key = str(mention.get("key") or "").strip()
        if not raw_key:
            continue
        source = raw_key if raw_key.startswith("@") else f"@{raw_key}"
        name = str(mention.get("name") or "").strip()
        if not name:
            mention_id = str(mention.get("id") or "").strip()
            name = str(member_names.get(mention_id) or "").strip()
        display_name = name.lstrip("@").strip()
        if display_name:
            replacements[source] = f"@{display_name}"
    if not replacements:
        return text
    pattern = re.compile("|".join(re.escape(key) for key in sorted(replacements, key=len, reverse=True)))
    return pattern.sub(lambda match: replacements[match.group(0)], text)


def message_text(
    message: dict[str, Any],
    attachments: list[dict[str, Any]],
    members: dict[str, str] | None = None,
) -> str:
    text = content_to_text(parse_content(message)).strip()
    if message.get("deleted"):
        return "[消息已撤回或删除]"
    text = resolve_mentions(text, message.get("mentions"), members)
    normalized_text = " ".join(text.split()).casefold()
    attachment_names = {
        " ".join(str(attachment.get("name") or "").split()).casefold()
        for attachment in attachments
        if attachment.get("name")
    }
    return "" if normalized_text and normalized_text in attachment_names else text


def extract_resources(message: dict[str, Any]) -> list[dict[str, str]]:
    if str(message.get("msg_type") or "") == "sticker":
        return []
    found: dict[tuple[str, str], dict[str, str]] = {}

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        suggested = ""
        for candidate in ("file_name", "name", "title"):
            value = node.get(candidate)
            if isinstance(value, str) and value.strip():
                suggested = value.strip()
                break
        for resource_type, key_name in (("image", "image_key"), ("file", "file_key")):
            key = node.get(key_name)
            if isinstance(key, str) and key:
                found[(resource_type, key)] = {"type": resource_type, "fileKey": key, "name": suggested}
        for value in node.values():
            if isinstance(value, (dict, list)):
                walk(value)

    walk(parse_content(message))
    return list(found.values())


def safe_filename(name: str, fallback: str = "unnamed") -> str:
    cleaned = INVALID_FILENAME_CHARS.sub("_", name).strip().rstrip(". ")
    cleaned = re.sub(r"\s+", " ", cleaned) or fallback
    if Path(cleaned).stem.upper() in WINDOWS_RESERVED_NAMES:
        cleaned = f"_{cleaned}"
    suffix = Path(cleaned).suffix[:20]
    if len(cleaned) > 180:
        cleaned = f"{Path(cleaned).stem[:150]}{suffix}"
    return cleaned


def header_filename(headers: Any) -> str:
    disposition = headers.get("Content-Disposition", "")
    match = re.search(r"filename\*=UTF-8''([^;]+)", disposition, flags=re.IGNORECASE)
    if match:
        return unquote(match.group(1))
    match = re.search(r'filename="?([^";]+)"?', disposition, flags=re.IGNORECASE)
    if not match:
        return ""
    filename = match.group(1).strip()
    try:
        # 部分服务把 UTF-8 文件名直接放进 legacy filename=，HTTP 客户端会按 Latin-1 解码。
        # 只有字节能组成合法 UTF-8 时才修复，合法的 Latin-1 文件名保持原样。
        return filename.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return filename


def download_resource(
    client: FeishuClient,
    output_dir: Path,
    message_id: str,
    resource: dict[str, str],
    cache: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    cache_key = f"{resource['type']}:{resource['fileKey']}"
    if cache_key in cache:
        return {**cache[cache_key], "status": "reused"}
    message_dir = output_dir / "attachments" / safe_filename(message_id)
    message_dir.mkdir(parents=True, exist_ok=True)
    try:
        response = client.open_resource(message_id, resource["fileKey"], resource["type"])
        try:
            original_name = header_filename(response.headers) or resource.get("name") or resource["fileKey"]
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0]
            filename = safe_filename(original_name, safe_filename(resource["fileKey"]))
            if not Path(filename).suffix and content_type:
                filename += mimetypes.guess_extension(content_type) or ""
            if not filename.startswith(safe_filename(resource["fileKey"])):
                filename = f"{safe_filename(resource['fileKey'])}__{filename}"
            target = message_dir / filename
            temporary = target.with_suffix(target.suffix + ".part")
            if target.is_file() and target.stat().st_size > 0:
                record = {
                    "type": resource["type"], "fileKey": resource["fileKey"], "name": original_name,
                    "status": "downloaded", "relativePath": target.relative_to(output_dir).as_posix(),
                    "size": target.stat().st_size, "error": "",
                }
                cache[cache_key] = record
                return record
            size = 0
            with temporary.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    size += len(chunk)
            if size <= 0:
                raise FeishuError("附件响应为空")
            os.replace(temporary, target)
            record = {
                "type": resource["type"], "fileKey": resource["fileKey"], "name": original_name,
                "status": "downloaded", "relativePath": target.relative_to(output_dir).as_posix(),
                "size": size, "error": "",
            }
            cache[cache_key] = record
            return record
        finally:
            response.close()
    except Exception as error:
        message = str(error)
        unavailable = "resource has been deleted" in message.casefold()
        record = {
            "type": resource["type"], "fileKey": resource["fileKey"],
            "name": resource.get("name") or resource["fileKey"],
            "status": "unavailable" if unavailable else "failed",
            "relativePath": "", "size": 0,
            "error": "源附件已被删除" if unavailable else message,
        }
        if unavailable:
            cache[cache_key] = record
        return record


def timestamp_to_iso(value: Any) -> str:
    try:
        raw = int(str(value))
        seconds = raw / 1000 if raw > 10_000_000_000 else raw
        return datetime.fromtimestamp(seconds).astimezone().isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError):
        return str(value or "")


def iso_to_epoch_seconds(value: Any, label: str) -> int:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return int(parsed.timestamp())
    except (TypeError, ValueError, OSError) as error:
        raise RuntimeError(f"{label}格式不合法") from error


def message_create_time_milliseconds(message: dict[str, Any]) -> int | None:
    try:
        raw = int(str(message.get("create_time") or ""))
        return raw if abs(raw) > 10_000_000_000 else raw * 1_000
    except (TypeError, ValueError):
        return None


def message_in_time_range(message: dict[str, Any], start_ms: int, end_ms_exclusive: int) -> bool:
    created_at = message_create_time_milliseconds(message)
    return created_at is not None and start_ms <= created_at < end_ms_exclusive


def sender_id(message: dict[str, Any]) -> tuple[str, str]:
    sender = message.get("sender") or {}
    if not isinstance(sender, dict):
        return "", ""
    return str(sender.get("id") or ""), str(sender.get("sender_type") or "")


def normalize_message(
    client: FeishuClient,
    message: dict[str, Any],
    members: dict[str, str],
    output_dir: Path,
    resource_cache: dict[str, dict[str, Any]],
    skip_attachments: set[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    message_id = str(message.get("message_id") or "")
    identity, sender_type = sender_id(message)
    if str(message.get("msg_type") or "") == "system":
        name = "系统消息"
    elif identity in members:
        name = members[identity]
    elif sender_type == "app":
        name = f"应用机器人（{identity or '未知ID'}）"
    else:
        name = f"未知用户（{identity or '未知ID'}）"
    attachments = []
    for resource in extract_resources(message):
        if (message_id, resource["fileKey"]) in (skip_attachments or set()):
            attachments.append({
                "type": resource["type"],
                "fileKey": resource["fileKey"],
                "name": resource.get("name") or resource["fileKey"],
                "status": "pending",
                "relativePath": "",
                "size": 0,
                "error": "历史附件状态可复用，已跳过来源下载",
                "storageStatus": "pending",
            })
        else:
            attachments.append(download_resource(client, output_dir, message_id, resource, resource_cache))
    text = message_text(message, attachments, members)
    return {
        "messageId": message_id,
        "chatId": str(message.get("chat_id") or ""),
        "senderId": identity,
        "senderName": name,
        "senderType": sender_type,
        "msgType": str(message.get("msg_type") or ""),
        "createTime": timestamp_to_iso(message.get("create_time")),
        "updateTime": timestamp_to_iso(message.get("update_time")),
        "text": text,
        "rootId": str(message.get("root_id") or ""),
        "parentId": str(message.get("parent_id") or ""),
        "deleted": bool(message.get("deleted")),
        "updated": bool(message.get("updated")),
        "attachments": attachments,
    }


def build_client(payload: dict[str, Any]) -> FeishuClient:
    app_id = str(payload.get("appId") or "").strip()
    app_secret = str(payload.get("appSecret") or "")
    if not app_id or not app_secret:
        raise RuntimeError("App ID 和 App Secret 不能为空")
    return FeishuClient(app_id, app_secret)


def run_chats(payload: dict[str, Any]) -> None:
    client = build_client(payload)
    client.tenant_access_token()
    chats = []
    for item in client.list_chats():
        if not item.get("chat_id"):
            continue
        raw_mode = str(item.get("chat_mode") or "group")
        chat_mode = raw_mode if raw_mode in {"group", "topic"} else "group"
        raw_status = str(item.get("chat_status") or "unknown")
        chat_status = raw_status if raw_status in {"normal", "dissolved", "dissolved_save"} else "unknown"
        chats.append({
            "chatId": str(item.get("chat_id") or ""),
            "name": str(item.get("name") or "未命名群"),
            "description": str(item.get("description") or ""),
            "chatMode": chat_mode,
            "chatStatus": chat_status,
            "external": bool(item.get("external")) if item.get("external") is not None else None,
            "ownerId": str(item.get("owner_id") or ""),
            "p2pTargetType": "",
            "p2pTargetId": "",
        })
    chats.sort(key=lambda item: (item["name"], item["chatId"]))
    emit({"event": "chats", "chats": chats})


def run_crawl(payload: dict[str, Any]) -> None:
    client = build_client(payload)
    chat_id = str(payload.get("chatId") or "")
    if not chat_id:
        raise RuntimeError("未选择群聊")
    start_time = iso_to_epoch_seconds(payload.get("startTime"), "开始时间")
    end_time_exclusive = iso_to_epoch_seconds(payload.get("endTimeExclusive"), "结束时间")
    if start_time >= end_time_exclusive:
        raise RuntimeError("开始时间必须早于结束时间")
    start_ms = start_time * 1_000
    end_ms_exclusive = end_time_exclusive * 1_000
    output_dir = Path(str(payload.get("outputDir") or "")).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        members = client.list_members(chat_id)
    except FeishuError as error:
        members = {}
        emit({"event": "warning", "message": f"无法获取群成员姓名：{error}"})
    page_token = str(payload.get("pageToken") or "")
    page_number = int(payload.get("pageNumber") or 0)
    resource_cache: dict[str, dict[str, Any]] = {}
    skip_attachments = {
        (str(item.get("messageId") or ""), str(item.get("fileKey") or ""))
        for item in (payload.get("skipAttachments") or [])
        if isinstance(item, dict) and item.get("messageId") and item.get("fileKey")
    }
    while True:
        messages, next_token, has_more = client.list_messages(
            chat_id,
            page_token,
            start_time,
            end_time_exclusive,
        )
        messages = [
            message
            for message in messages
            if message_in_time_range(message, start_ms, end_ms_exclusive)
        ]
        normalized = [
            normalize_message(client, message, members, output_dir, resource_cache, skip_attachments)
            for message in messages
        ]
        page_number += 1
        attachment_count = sum(len(message["attachments"]) for message in normalized)
        attachment_failed_count = sum(
            1
            for message in normalized
            for attachment in message["attachments"]
            if attachment["status"] in {"failed", "unavailable"}
        )
        emit({
            "event": "page",
            "pageNumber": page_number,
            "messages": normalized,
            "nextPageToken": next_token if has_more else "",
            "hasMore": has_more,
            "attachmentCount": attachment_count,
            "attachmentFailedCount": attachment_failed_count,
        })
        if not has_more:
            break
        if not next_token or next_token == page_token:
            raise FeishuError("消息分页标记异常")
        page_token = next_token
    emit({"event": "done"})


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"chats", "crawl"}:
        print("usage: feishu_bridge.py chats|crawl", file=sys.stderr)
        return 2
    try:
        payload = read_payload()
        if sys.argv[1] == "chats":
            run_chats(payload)
        else:
            run_crawl(payload)
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
