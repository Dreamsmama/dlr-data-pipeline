export interface LarkMessageMention {
  id?: unknown;
  key?: unknown;
  name?: unknown;
}

export interface ConfirmedMention {
  id: string;
  name: string;
}

export type MentionResolutionResult =
  | {
      ok: true;
      resolvedText: string;
      mapping: Record<string, ConfirmedMention>;
    }
  | {
      ok: false;
      reason: "no_placeholder" | "missing_name" | "conflicting_mapping" | "unresolved_placeholder" | "content_mismatch";
    };

const PLACEHOLDER_PATTERN = /@_user_\d+/g;
const PLACEHOLDER_KEY_PATTERN = /^@_user_\d+$/;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveStoredMentions(
  originalText: string,
  larkContent: string,
  mentions: unknown,
): MentionResolutionResult {
  const placeholders = [...new Set(originalText.match(PLACEHOLDER_PATTERN) ?? [])];
  if (!placeholders.length) return { ok: false, reason: "no_placeholder" };

  const mapping: Record<string, ConfirmedMention> = {};
  if (Array.isArray(mentions)) {
    for (const value of mentions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const mention = value as LarkMessageMention;
      const key = stringValue(mention.key);
      const id = stringValue(mention.id);
      const name = stringValue(mention.name).replace(/^@+/, "").trim();
      if (!PLACEHOLDER_KEY_PATTERN.test(key) || !id || !name) continue;
      const current = mapping[key];
      if (current && (current.id !== id || current.name !== name)) {
        return { ok: false, reason: "conflicting_mapping" };
      }
      mapping[key] = { id, name };
    }
  }

  for (const placeholder of placeholders) {
    if (!mapping[placeholder]) return { ok: false, reason: "missing_name" };
  }

  let resolvedText = originalText;
  for (const placeholder of [...placeholders].sort((left, right) => right.length - left.length)) {
    resolvedText = resolvedText.replaceAll(placeholder, `@${mapping[placeholder]!.name}`);
  }
  if (PLACEHOLDER_PATTERN.test(resolvedText)) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    return { ok: false, reason: "unresolved_placeholder" };
  }
  PLACEHOLDER_PATTERN.lastIndex = 0;
  if (resolvedText !== larkContent) return { ok: false, reason: "content_mismatch" };
  return { ok: true, resolvedText, mapping };
}
