import type { PersistedChangeKind, PersistedItem } from "./db.ts";

export interface UndoableChange {
  readonly itemId: string;
  readonly label: string;
  readonly mutation: Record<string, unknown>;
  readonly targetTags?: string[];
  readonly expectedItem: PersistedItem;
}

export function createUndoableChange(
  kind: PersistedChangeKind,
  beforeItem: PersistedItem | undefined,
  afterItem: PersistedItem,
): UndoableChange {
  const base = {
    itemId: afterItem.id,
    label: afterItem.title?.trim() || afterItem.url,
    expectedItem: cloneItem(afterItem),
  };

  if (kind === "create") {
    return {
      ...base,
      mutation: { type: "delete", item_id: afterItem.id },
    };
  }
  if (!beforeItem) {
    throw new Error("The previous item state required for undo is unavailable.");
  }
  if (kind === "delete") {
    return {
      ...base,
      mutation: { type: "restore", item_id: afterItem.id },
    };
  }
  if (kind === "restore") {
    return {
      ...base,
      mutation: { type: "delete", item_id: afterItem.id },
    };
  }

  const mutation: Record<string, unknown> = {
    type: "edit",
    item_id: afterItem.id,
  };
  if (beforeItem.url !== afterItem.url) mutation.url = beforeItem.url;
  if (beforeItem.title !== afterItem.title) mutation.title = textUpdate(beforeItem.title);
  if (beforeItem.excerpt !== afterItem.excerpt) {
    mutation.excerpt = textUpdate(beforeItem.excerpt);
  }
  if (beforeItem.note !== afterItem.note) {
    mutation.note = textUpdate(beforeItem.note);
    mutation.expected_note = afterItem.note;
  }
  if (beforeItem.favorite !== afterItem.favorite) mutation.favorite = beforeItem.favorite;
  if (beforeItem.language !== afterItem.language) {
    mutation.language = textUpdate(beforeItem.language);
  }
  const tagsChanged = !sameTags(beforeItem.tags, afterItem.tags);

  return {
    ...base,
    mutation,
    targetTags: tagsChanged ? [...beforeItem.tags] : undefined,
  };
}

export function matchesUndoExpectation(
  current: PersistedItem | undefined,
  expected: PersistedItem,
): boolean {
  return Boolean(
    current &&
      current.id === expected.id &&
      current.url === expected.url &&
      current.title === expected.title &&
      current.excerpt === expected.excerpt &&
      current.note === expected.note &&
      current.favorite === expected.favorite &&
      current.language === expected.language &&
      current.savedAt === expected.savedAt &&
      current.savedAtUnix === expected.savedAtUnix &&
      current.deleted === expected.deleted &&
      sameTags(current.tags, expected.tags),
  );
}

function textUpdate(value: string | null) {
  return value === null ? { type: "clear" } : { type: "set", value };
}

function sameTags(left: string[], right: string[]) {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function cloneItem(item: PersistedItem): PersistedItem {
  return { ...item, tags: [...item.tags] };
}
