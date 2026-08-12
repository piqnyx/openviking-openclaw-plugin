import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "..");
const patcher = resolve(root, "tools/apply-issue30-hardening.mjs");

let text = readFileSync(patcher, "utf8");
const before = text;
text = text.replace(
  '"Explicit `category` is not an exact writable taxonomy destination.',
  '"Explicit \\`category\\` is not an exact writable taxonomy destination.',
);
text = text.replace(
  'retry once with `category` omitted so automatic routing can decide.',
  'retry once with \\`category\\` omitted so automatic routing can decide.',
);
if (text === before) {
  throw new Error("issue30 patcher syntax fixer made no changes");
}
writeFileSync(patcher, text);
unlinkSync(self);
console.log("ISSUE30_PATCHER_FIX_OK");
