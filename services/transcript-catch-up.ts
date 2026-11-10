import { collectToolUseInputs, extractMessageForCapture } from "../text-utils.js";
import {
  coalesceConsecutiveToolMessages,
  normalizeTimestamp,
  toOvParts,
  type CaptureMessage,
  type RecordedOvPart,
} from "./capture-form.js";

/** One row of the gateway's visible branch of its own session, as the runtime's reader hands it. */
export type BranchRow = {
  entryId: string;
  /** The id the row was first written under: it survives the gateway's own rewrites. */
  firstEntryId: string;
  message: unknown;
  /** The transcript store's entry time, when it has one. */
  createdAt?: string;
};

/** A message to write: in the capture form, named by the rows it was made of, with its own time. */
export type CatchUpMessage = {
  role: "user" | "assistant";
  parts: RecordedOvPart[];
  sourceIds: string[];
  createdAt?: string;
};

/**
 * PLAN-krug Р1: what to write so that Viking holds the gateway's branch -- the rows after the
 * newest one Viking already holds (by the id the row was first written under), in the capture
 * form. A row Viking holds is never written again, whatever reads it twice.
 *
 * `holdTrailingQuestion` (mid-turn only, PLAN-krug П3'): a trailing question with nothing after it
 * belongs to the turn still running and waits for its continuation. Everywhere else it is written:
 * the question of a turn that broke off or ended with no visible reply stays on the gateway's
 * branch, and the model sees it next to the next question.
 */
export function planTranscriptCatchUp(params: {
  rows: readonly BranchRow[];
  seenIds: ReadonlySet<string>;
  holdTrailingQuestion: boolean;
}): { messages: CatchUpMessage[]; heldQuestionId?: string } {
  const { rows } = params;
  const bookmark = newestSeenIndex(rows, params.seenIds);
  const last = rows.at(-1);
  // The questions at the branch's end with nothing after them wait together -- a question and the lines added
  // to it before any answer are one turn's prompt; one of them written ahead would stand in the next window
  // beside the same question in the gateway's prompt (plugin review, 10.11).
  let end = rows.length;
  while (params.holdTrailingQuestion && end - 1 > bookmark && roleOf(rows[end - 1]?.message) === "user") {
    end -= 1;
  }
  const holdsQuestion = end < rows.length;

  // Tool calls before the bookmark still name the inputs of the results after it.
  const toolUseInputs = collectToolUseInputs(rows.slice(0, end).map((row) => row.message));
  const captured: CaptureMessage[] = [];
  for (let index = bookmark + 1; index < end; index += 1) {
    const { message } = extractMessageForCapture(rows[index]?.message, toolUseInputs);
    if (message) {
      captured.push({ ...message, rows: [index] });
    }
  }
  const messages = coalesceConsecutiveToolMessages(captured).flatMap((message): CatchUpMessage[] => {
    const parts = toOvParts(message);
    if (parts.length === 0) {
      return [];
    }
    const sourceRows = message.rows.flatMap((index) => (rows[index] ? [rows[index]] : []));
    const createdAt = newestTimeOf(sourceRows);
    return [
      {
        role: message.role,
        parts,
        sourceIds: sourceRows.map((row) => row.firstEntryId),
        ...(createdAt ? { createdAt } : {}),
      },
    ];
  });
  return holdsQuestion && last ? { messages, heldQuestionId: last.firstEntryId } : { messages };
}

function newestSeenIndex(rows: readonly BranchRow[], seenIds: ReadonlySet<string>): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && seenIds.has(row.firstEntryId)) {
      return index;
    }
  }
  return -1;
}

function roleOf(message: unknown): string | undefined {
  const role = message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;
  return typeof role === "string" ? role : undefined;
}

// The message's own time first (the capture has always taken it), else the store's entry time;
// a message made of several rows takes the newest of theirs.
function newestTimeOf(rows: readonly BranchRow[]): string | undefined {
  let newest: { iso: string; ms: number } | undefined;
  for (const row of rows) {
    const iso = normalizeTimestamp((row.message as { timestamp?: unknown } | undefined)?.timestamp) ?? row.createdAt;
    const ms = iso ? Date.parse(iso) : Number.NaN;
    if (iso && Number.isFinite(ms) && (!newest || ms > newest.ms)) {
      newest = { iso, ms };
    }
  }
  return newest?.iso;
}
