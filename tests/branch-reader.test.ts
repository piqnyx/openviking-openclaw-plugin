import { describe, expect, it, vi } from "vitest";

import {
  readBranchSinceBookmark,
  transcriptReaderOf,
  type BranchMemory,
  type SessionTranscriptReader,
} from "../services/branch-reader.js";
import type { BranchRow } from "../services/transcript-catch-up.js";

/*
 * PLAN-krug 7б: ветка шлюза читается страницами от курсора сессии; в памяти -- только строки от
 * начала хода (строки пользователя) новейшей строки, которую Викинг держит, -- оттуда и аргументы
 * инструментов для выдач после закладки. Сдвиг ветки (перезапись, откат) шлюз отдаёт как `reset` --
 * тогда чтение с начала. Отбор «как видит модель» делает сам шлюз на всём прочитанном наборе.
 */

function row(id: string, role: string, text = id): BranchRow {
  return { entryId: id, firstEntryId: id, message: { role, content: text } };
}

/** A gateway reader over a fixed branch, pages of `pageSize`; `resetOnce` answers reset first. */
function reader(branch: BranchRow[], options: { pageSize?: number; resetOnce?: boolean } = {}) {
  const pageSize = options.pageSize ?? 2;
  let resetPending = options.resetOnce === true;
  const cursors: Array<string | undefined> = [];
  const readVisiblePage = vi.fn(async (limits?: { cursor?: string }) => {
    cursors.push(limits?.cursor);
    if (resetPending) {
      resetPending = false;
      return { kind: "reset" as const, cursor: "c0", reason: "anchor_moved" as const };
    }
    const start = limits?.cursor ? Number(limits.cursor.slice(1)) : 0;
    const rows = branch.slice(start, start + pageSize);
    const next = start + rows.length;
    return { kind: "page" as const, cursor: `c${next}`, rows, hasMore: next < branch.length };
  });
  const value: SessionTranscriptReader = {
    readVisiblePage,
    selectModelVisible: (rows) => rows.filter((candidate) => !String(candidate.message && (candidate.message as { content?: unknown }).content).startsWith("hidden")),
  };
  return { value, cursors };
}

const ids = (rows: readonly BranchRow[]) => rows.map((candidate) => candidate.entryId);

describe("чтение ветки шлюза", () => {
  it("читает все страницы и держит строки от начала хода с закладкой", async () => {
    const branch = [row("u1", "user"), row("a1", "assistant"), row("u2", "user"), row("a2", "assistant"), row("u3", "user")];
    const { value } = reader(branch);

    const read = await readBranchSinceBookmark({ reader: value, seenIds: new Set(["a2"]) });

    expect(read.kind).toBe("rows");
    expect(read.kind === "rows" && ids(read.memory.rows)).toEqual(["u2", "a2", "u3"]);
  });

  it("без закладки держит ветку целиком", async () => {
    const branch = [row("u1", "user"), row("a1", "assistant")];
    const { value } = reader(branch);

    const read = await readBranchSinceBookmark({ reader: value, seenIds: new Set() });

    expect(read.kind === "rows" && ids(read.memory.rows)).toEqual(["u1", "a1"]);
  });

  it("продолжает с курсора памяти и дочитывает только новое", async () => {
    const branch = [row("u1", "user"), row("a1", "assistant"), row("u2", "user"), row("a2", "assistant")];
    const { value, cursors } = reader(branch);
    const memory: BranchMemory = { cursor: "c2", rows: [branch[0]!, branch[1]!] };

    const read = await readBranchSinceBookmark({ reader: value, seenIds: new Set(["a1"]), memory });

    expect(cursors).toEqual(["c2"]);
    expect(read.kind === "rows" && ids(read.memory.rows)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("сдвиг ветки -- чтение с начала, память не в счёт", async () => {
    const branch = [row("u1", "user"), row("a1-new", "assistant")];
    const { value, cursors } = reader(branch, { resetOnce: true });
    const memory: BranchMemory = { cursor: "c9", rows: [row("u1", "user"), row("a1-old", "assistant")] };

    const read = await readBranchSinceBookmark({ reader: value, seenIds: new Set(["u1"]), memory });

    expect(cursors).toEqual(["c9", "c0"]);
    expect(read.kind === "rows" && ids(read.memory.rows)).toEqual(["u1", "a1-new"]);
  });

  it("отдаёт строки так, как их видит модель, -- отбор шлюза на всём наборе", async () => {
    const branch = [row("u1", "user"), row("x1", "assistant", "hidden mirror"), row("a1", "assistant")];
    const { value } = reader(branch);

    const read = await readBranchSinceBookmark({ reader: value, seenIds: new Set() });

    expect(read.kind === "rows" && ids(read.visible)).toEqual(["u1", "a1"]);
    expect(read.kind === "rows" && ids(read.memory.rows)).toEqual(["u1", "x1", "a1"]);
  });

  it("говорит, когда переписки нет или она перестраивается", async () => {
    const missing: SessionTranscriptReader = {
      readVisiblePage: async () => ({ kind: "missing" }),
      selectModelVisible: (rows) => rows,
    };
    const rebuilding: SessionTranscriptReader = {
      readVisiblePage: async () => ({ kind: "unavailable", reason: "projection_rebuilding" }),
      selectModelVisible: (rows) => rows,
    };

    await expect(readBranchSinceBookmark({ reader: missing, seenIds: new Set() })).resolves.toEqual({ kind: "missing" });
    await expect(readBranchSinceBookmark({ reader: rebuilding, seenIds: new Set() })).resolves.toEqual({
      kind: "unavailable",
      reason: "projection_rebuilding",
    });
  });

  it("берёт читателя из контекста хода, только если он настоящий", () => {
    const { value } = reader([]);

    expect(transcriptReaderOf({ readSessionTranscript: value })).toBe(value);
    expect(transcriptReaderOf({ readSessionTranscript: { readVisiblePage: 1 } })).toBeUndefined();
    expect(transcriptReaderOf(undefined)).toBeUndefined();
  });
});
