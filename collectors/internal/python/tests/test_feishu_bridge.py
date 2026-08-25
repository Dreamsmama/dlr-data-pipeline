import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from feishu_bridge import (  # noqa: E402
    content_to_text,
    extract_resources,
    header_filename,
    iso_to_epoch_seconds,
    message_in_time_range,
    message_text,
    parse_content,
    resolve_mentions,
    run_chats,
    run_crawl,
    safe_filename,
)


class FeishuBridgeTests(unittest.TestCase):
    def test_robot_chat_discovery_preserves_group_and_topic_modes(self):
        class FakeClient:
            def tenant_access_token(self):
                return "token"

            def list_chats(self):
                return [
                    {
                        "chat_id": "oc_group",
                        "name": "项目群",
                        "chat_mode": "group",
                        "chat_status": "normal",
                        "external": False,
                        "owner_id": "ou_owner",
                    },
                    {
                        "chat_id": "oc_topic",
                        "name": "话题群",
                        "chat_mode": "topic",
                        "chat_status": "normal",
                        "external": True,
                    },
                ]

        output = io.StringIO()
        with patch("feishu_bridge.build_client", return_value=FakeClient()), redirect_stdout(output):
            run_chats({"appId": "cli_test", "appSecret": "secret"})
        event = json.loads(output.getvalue())
        chats = {item["chatId"]: item for item in event["chats"]}
        self.assertEqual(chats["oc_group"]["chatMode"], "group")
        self.assertEqual(chats["oc_topic"]["chatMode"], "topic")
        self.assertEqual(chats["oc_group"]["ownerId"], "ou_owner")
        self.assertFalse(chats["oc_group"]["external"])
        self.assertTrue(chats["oc_topic"]["external"])

    def test_time_range_uses_message_create_time_with_exclusive_end(self):
        start_ms = iso_to_epoch_seconds("2026-08-21T02:00:00.000Z", "开始时间") * 1000
        end_ms = iso_to_epoch_seconds("2026-08-21T02:01:00.000Z", "结束时间") * 1000
        self.assertTrue(message_in_time_range({"create_time": str(start_ms)}, start_ms, end_ms))
        self.assertTrue(message_in_time_range({"create_time": str(end_ms - 1)}, start_ms, end_ms))
        self.assertFalse(message_in_time_range({"create_time": str(start_ms - 1)}, start_ms, end_ms))
        self.assertFalse(message_in_time_range({"create_time": str(end_ms)}, start_ms, end_ms))
        self.assertFalse(message_in_time_range({"create_time": "invalid"}, start_ms, end_ms))

    def test_iso_range_requires_timezone(self):
        with self.assertRaisesRegex(RuntimeError, "开始时间格式不合法"):
            iso_to_epoch_seconds("2026-08-21T10:00:00", "开始时间")

    def test_crawl_filters_raw_create_time_before_downloading_attachments(self):
        start_ms = 1_777_000_000_000
        end_ms = start_ms + 60_000

        class FakeClient:
            request_range = None
            resource_opened = False

            def list_members(self, _chat_id):
                return {}

            def list_messages(self, _chat_id, _page_token, start_time, end_time):
                self.request_range = (start_time, end_time)
                return ([
                    {"message_id": "start", "chat_id": "oc_test", "create_time": str(start_ms), "body": {"content": "{}"}},
                    {"message_id": "end-minus-one", "chat_id": "oc_test", "create_time": str(end_ms - 1), "body": {"content": "{}"}},
                    {
                        "message_id": "outside",
                        "chat_id": "oc_test",
                        "create_time": str(end_ms),
                        "msg_type": "image",
                        "body": {"content": json.dumps({"image_key": "outside-image"})},
                    },
                ], "", False)

            def open_resource(self, *_args):
                self.resource_opened = True
                raise AssertionError("范围外附件不应下载")

        client = FakeClient()
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch("feishu_bridge.build_client", return_value=client):
            with redirect_stdout(output):
                run_crawl({
                    "appId": "cli_test",
                    "appSecret": "secret",
                    "chatId": "oc_test",
                    "outputDir": directory,
                    "startTime": datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).isoformat(),
                    "endTimeExclusive": datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).isoformat(),
                })
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        page = next(event for event in events if event["event"] == "page")
        self.assertEqual([item["messageId"] for item in page["messages"]], ["start", "end-minus-one"])
        self.assertEqual(client.request_range, (start_ms // 1000, end_ms // 1000))
        self.assertFalse(client.resource_opened)

    def test_crawl_skips_a_previously_uploaded_attachment_before_source_download(self):
        start_ms = 1_777_000_000_000
        end_ms = start_ms + 60_000

        class FakeClient:
            resource_opened = False

            def list_members(self, _chat_id):
                return {}

            def list_messages(self, _chat_id, _page_token, _start_time, _end_time):
                return ([{
                    "message_id": "om_existing",
                    "chat_id": "oc_test",
                    "create_time": str(start_ms),
                    "msg_type": "image",
                    "body": {"content": json.dumps({"image_key": "img_existing"})},
                }], "", False)

            def open_resource(self, *_args):
                self.resource_opened = True
                raise AssertionError("已上传附件不应再次调用飞书下载接口")

        client = FakeClient()
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch("feishu_bridge.build_client", return_value=client):
            with redirect_stdout(output):
                run_crawl({
                    "appId": "cli_test",
                    "appSecret": "secret",
                    "chatId": "oc_test",
                    "outputDir": directory,
                    "startTime": datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).isoformat(),
                    "endTimeExclusive": datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).isoformat(),
                    "skipAttachments": [{"messageId": "om_existing", "fileKey": "img_existing"}],
                })
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        attachment = next(event for event in events if event["event"] == "page")["messages"][0]["attachments"][0]
        self.assertFalse(client.resource_opened)
        self.assertEqual(attachment["status"], "pending")
        self.assertEqual(attachment["storageStatus"], "pending")

    def test_content_is_parsed_and_flattened(self):
        message = {
            "body": {
                "content": json.dumps(
                    {"title": "项目更新", "elements": [[{"tag": "text", "text": "第一版完成"}]]},
                    ensure_ascii=False,
                )
            }
        }
        parsed = parse_content(message)
        self.assertIn("项目更新", content_to_text(parsed))
        self.assertIn("第一版完成", content_to_text(parsed))

    def test_structural_title_and_body_duplicates_are_collapsed(self):
        content = {"title": "这是图片文件", "content": [[{"tag": "text", "text": "这是图片文件"}]]}
        self.assertEqual(content_to_text(content), "这是图片文件")

    def test_repeated_text_inside_a_list_is_preserved(self):
        content = [{"tag": "text", "text": "重复"}, {"tag": "text", "text": "重复"}]
        self.assertEqual(content_to_text(content), "重复 重复")

    def test_attachment_name_is_not_repeated_as_message_text(self):
        message = {
            "msg_type": "file",
            "body": {"content": json.dumps({"file_key": "file_1", "file_name": "报告.xlsx"}, ensure_ascii=False)},
        }
        attachments = [{"type": "file", "fileKey": "file_1", "name": "报告.xlsx"}]
        self.assertEqual(message_text(message, attachments), "")

    def test_message_mentions_are_replaced_with_their_display_names(self):
        message = {
            "msg_type": "text",
            "body": {"content": json.dumps({"text": "@_user_1 请确认"}, ensure_ascii=False)},
            "mentions": [{"key": "@_user_1", "id": "ou_1", "name": "张三"}],
        }
        self.assertEqual(message_text(message, []), "@张三 请确认")

    def test_multiple_mentions_do_not_confuse_prefix_keys(self):
        mentions = [
            {"key": "@_user_1", "id": "ou_1", "name": "张三"},
            {"key": "_user_10", "id": "ou_10", "name": "@李四"},
        ]
        self.assertEqual(
            resolve_mentions("@_user_1 和 @_user_10 请确认", mentions),
            "@张三 和 @李四 请确认",
        )

    def test_mention_without_name_uses_matching_group_member(self):
        mentions = [{"key": "@_user_1", "id": "ou_member", "name": ""}]
        self.assertEqual(
            resolve_mentions("@_user_1 收到吗", mentions, {"ou_member": "王五"}),
            "@王五 收到吗",
        )

    def test_unresolved_mention_and_similar_plain_text_are_preserved(self):
        self.assertEqual(
            resolve_mentions("@_user_1 和日志 _user_2", [{"key": "@_user_1", "id": "ou_missing"}]),
            "@_user_1 和日志 _user_2",
        )

    def test_rich_text_mentions_are_resolved_after_flattening(self):
        message = {
            "msg_type": "post",
            "body": {
                "content": json.dumps(
                    {
                        "title": "项目更新",
                        "content": [[
                            {"tag": "text", "text": "@_user_1"},
                            {"tag": "text", "text": "请和"},
                            {"tag": "text", "text": "@_user_2"},
                            {"tag": "text", "text": "确认"},
                        ]],
                    },
                    ensure_ascii=False,
                )
            },
            "mentions": [
                {"key": "@_user_1", "id": "ou_1", "name": "张三"},
                {"key": "@_user_2", "id": "ou_2", "name": "李四"},
            ],
        }
        self.assertEqual(message_text(message, []), "项目更新 @张三 请和 @李四 确认")

    def test_nested_resources_are_deduplicated(self):
        message = {
            "message_id": "om_1",
            "msg_type": "post",
            "body": {
                "content": json.dumps(
                    {
                        "content": [
                            {"image_key": "img_1"},
                            {"image_key": "img_1"},
                            {"file_key": "file_1", "file_name": "报告.xlsx"},
                        ]
                    },
                    ensure_ascii=False,
                )
            },
        }
        resources = extract_resources(message)
        self.assertEqual({(item["type"], item["fileKey"]) for item in resources}, {("image", "img_1"), ("file", "file_1")})

    def test_sticker_is_not_treated_as_downloadable_resource(self):
        message = {
            "message_id": "om_2",
            "msg_type": "sticker",
            "body": {"content": json.dumps({"file_key": "file_1"})},
        }
        self.assertEqual(extract_resources(message), [])

    def test_windows_safe_filename(self):
        self.assertEqual(safe_filename('a<b>:c?.txt'), "a_b__c_.txt")
        self.assertEqual(safe_filename("CON.txt"), "_CON.txt")

    def test_legacy_header_utf8_filename_is_repaired(self):
        expected = "报销6月.zip"
        mojibake = expected.encode("utf-8").decode("latin-1")
        self.assertEqual(
            header_filename({"Content-Disposition": f'attachment; filename="{mojibake}"'}),
            expected,
        )
        self.assertEqual(
            header_filename({"Content-Disposition": 'attachment; filename="café.txt"'}),
            "café.txt",
        )


if __name__ == "__main__":
    unittest.main()
