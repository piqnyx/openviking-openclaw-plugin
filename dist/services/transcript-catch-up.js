import { collectToolUseInputs, extractMessageForCapture } from "../text-utils.js";
import { coalesceConsecutiveToolMessages, normalizeTimestamp, toOvParts, } from "./capture-form.js";
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
export function planTranscriptCatchUp(params) {
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
    const captured = [];
    for (let index = bookmark + 1; index < end; index += 1) {
        const { message } = extractMessageForCapture(rows[index]?.message, toolUseInputs);
        if (message) {
            captured.push({ ...message, rows: [index] });
        }
    }
    const messages = coalesceConsecutiveToolMessages(captured).flatMap((message) => {
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
function newestSeenIndex(rows, seenIds) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row && seenIds.has(row.firstEntryId)) {
            return index;
        }
    }
    return -1;
}
function roleOf(message) {
    const role = message && typeof message === "object" ? message.role : undefined;
    return typeof role === "string" ? role : undefined;
}
// The message's own time first (the capture has always taken it), else the store's entry time;
// a message made of several rows takes the newest of theirs.
function newestTimeOf(rows) {
    let newest;
    for (const row of rows) {
        const iso = normalizeTimestamp(row.message?.timestamp) ?? row.createdAt;
        const ms = iso ? Date.parse(iso) : Number.NaN;
        if (iso && Number.isFinite(ms) && (!newest || ms > newest.ms)) {
            newest = { iso, ms };
        }
    }
    return newest?.iso;
}
