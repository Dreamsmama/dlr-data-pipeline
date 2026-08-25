import assert from "node:assert/strict";
import test from "node:test";

import { resolveStoredMentions } from "./mention-resolution.js";

test("resolves a single placeholder only when the full Lark content matches", () => {
  assert.deepEqual(
    resolveStoredMentions(
      "@_user_1 你好",
      "@李月 你好",
      [{ id: "ou_li", key: "@_user_1", name: "李月" }],
    ),
    {
      ok: true,
      resolvedText: "@李月 你好",
      mapping: { "@_user_1": { id: "ou_li", name: "李月" } },
    },
  );
});

test("resolves every placeholder in a multi-mention message", () => {
  const result = resolveStoredMentions(
    "@_user_1 和 @_user_2 请确认",
    "@李月 和 @梁璐 请确认",
    [
      { id: "ou_li", key: "@_user_1", name: "李月" },
      { id: "ou_liang", key: "@_user_2", name: "@梁璐" },
    ],
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.resolvedText, "@李月 和 @梁璐 请确认");
    assert.deepEqual(result.mapping["@_user_2"], { id: "ou_liang", name: "梁璐" });
  }
});

test("does not resolve missing or blank mention names", () => {
  assert.deepEqual(
    resolveStoredMentions(
      "@_user_1 你好",
      "@_user_1 你好",
      [{ id: "ou_li", key: "@_user_1", name: "" }],
    ),
    { ok: false, reason: "missing_name" },
  );
});

test("does not resolve conflicting mappings for the same message key", () => {
  assert.deepEqual(
    resolveStoredMentions(
      "@_user_1 你好",
      "@李月 你好",
      [
        { id: "ou_li", key: "@_user_1", name: "李月" },
        { id: "ou_other", key: "@_user_1", name: "梁璐" },
      ],
    ),
    { ok: false, reason: "conflicting_mapping" },
  );
});

test("does not resolve when Lark content differs beyond mention replacement", () => {
  assert.deepEqual(
    resolveStoredMentions(
      "@_user_1 你好",
      "@李月 你好，内容已编辑",
      [{ id: "ou_li", key: "@_user_1", name: "李月" }],
    ),
    { ok: false, reason: "content_mismatch" },
  );
});

test("does not alter text without placeholders", () => {
  assert.deepEqual(
    resolveStoredMentions("@李月 你好", "@李月 你好", []),
    { ok: false, reason: "no_placeholder" },
  );
});
