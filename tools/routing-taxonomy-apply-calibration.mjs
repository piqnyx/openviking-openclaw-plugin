import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_TAXONOMY = resolve(repoRoot, "examples/resource-taxonomy.ru.yaml");
const DEFAULT_CASES = resolve(repoRoot, "examples/routing-cases.ru.json");
const DEFAULT_CALIBRATION = resolve(repoRoot, "examples/resource-taxonomy.ru.calibration.json");

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function categoryIndex(categories, out = new Map()) {
  const record = asRecord(categories, "taxonomy.categories");
  for (const [key, raw] of Object.entries(record)) {
    const node = asRecord(raw, `taxonomy category ${key}`);
    if (out.has(key)) throw new Error(`duplicate taxonomy key ${key}`);
    out.set(key, node);
    if (node.children !== undefined) categoryIndex(node.children, out);
  }
  return out;
}

function appendUniqueStrings(current, additions, label) {
  const base = current === undefined ? [] : current;
  if (!Array.isArray(base) || base.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (!Array.isArray(additions) || additions.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} additions must be an array of non-empty strings`);
  }
  return [...new Set([...base, ...additions])];
}

export function applyRoutingCalibration({ taxonomyDocument, cases, calibration }) {
  const taxonomy = clone(taxonomyDocument);
  const routedCases = clone(cases);
  const spec = asRecord(calibration, "calibration");
  if (spec.schemaVersion !== 1) throw new Error(`unsupported calibration schemaVersion ${spec.schemaVersion}`);
  if (!Array.isArray(routedCases)) throw new Error("routing cases must be an array");

  const categories = categoryIndex(asRecord(taxonomy, "taxonomy").categories);
  const taxonomyPatches = asRecord(spec.taxonomy, "calibration.taxonomy");
  let taxonomyChanges = 0;

  for (const [key, rawPatch] of Object.entries(taxonomyPatches)) {
    const node = categories.get(key);
    if (!node) throw new Error(`calibration references unknown taxonomy key ${key}`);
    const patch = asRecord(rawPatch, `calibration.taxonomy.${key}`);
    const allowed = new Set(["description", "addDistinguishFrom"]);
    for (const field of Object.keys(patch)) {
      if (!allowed.has(field)) throw new Error(`unsupported taxonomy patch field ${key}.${field}`);
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== "string" || !patch.description.trim()) {
        throw new Error(`${key}.description must be a non-empty string`);
      }
      node.description = patch.description.trim();
    }
    if (patch.addDistinguishFrom !== undefined) {
      node.distinguishFrom = appendUniqueStrings(
        node.distinguishFrom,
        patch.addDistinguishFrom,
        `${key}.distinguishFrom`,
      );
    }
    taxonomyChanges += 1;
  }

  const byCaseId = new Map();
  for (const item of routedCases) {
    const record = asRecord(item, "routing case");
    if (typeof record.id !== "string" || !record.id.trim()) throw new Error("routing case id must be non-empty");
    if (byCaseId.has(record.id)) throw new Error(`duplicate routing case id ${record.id}`);
    byCaseId.set(record.id, record);
  }

  const casePatches = asRecord(spec.cases, "calibration.cases");
  let caseChanges = 0;
  for (const [id, rawPatch] of Object.entries(casePatches)) {
    const item = byCaseId.get(id);
    if (!item) throw new Error(`calibration references unknown routing case ${id}`);
    const patch = asRecord(rawPatch, `calibration.cases.${id}`);
    const allowed = new Set(["summary", "expected"]);
    for (const field of Object.keys(patch)) {
      if (!allowed.has(field)) throw new Error(`unsupported routing case patch field ${id}.${field}`);
    }
    if (patch.summary !== undefined) {
      if (typeof patch.summary !== "string" || !patch.summary.trim()) throw new Error(`${id}.summary must be non-empty`);
      item.summary = patch.summary.trim();
    }
    if (patch.expected !== undefined) {
      if (typeof patch.expected !== "string" || !patch.expected.trim()) throw new Error(`${id}.expected must be non-empty`);
      item.expected = patch.expected.trim();
    }
    caseChanges += 1;
  }

  return {
    taxonomy,
    cases: routedCases,
    calibrationId: typeof spec.id === "string" ? spec.id : undefined,
    taxonomyChanges,
    caseChanges,
  };
}

function atomicWrite(path, text) {
  const target = resolve(path);
  const temp = resolve(dirname(target), `.${basename(target)}.tmp-${process.pid}-${Date.now()}`);
  const mode = existsSync(target) ? statSync(target).mode : 0o644;
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    taxonomyIn: DEFAULT_TAXONOMY,
    casesIn: DEFAULT_CASES,
    calibration: DEFAULT_CALIBRATION,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const value = requireValue(argv, index, arg);
    index += 1;
    switch (arg) {
      case "--taxonomy-in": options.taxonomyIn = resolve(value); break;
      case "--taxonomy-out": options.taxonomyOut = resolve(value); break;
      case "--cases-in": options.casesIn = resolve(value); break;
      case "--cases-out": options.casesOut = resolve(value); break;
      case "--calibration": options.calibration = resolve(value); break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

function usage() {
  return `Usage:\n  node tools/routing-taxonomy-apply-calibration.mjs --check\n  node tools/routing-taxonomy-apply-calibration.mjs --taxonomy-out PATH --cases-out PATH\n\nOptions:\n  --taxonomy-in PATH   Base taxonomy (default examples/resource-taxonomy.ru.yaml)\n  --taxonomy-out PATH  Write calibrated taxonomy here\n  --cases-in PATH      Base routing cases (default examples/routing-cases.ru.json)\n  --cases-out PATH     Write calibrated routing cases here\n  --calibration PATH   Calibration patch JSON\n  --check              Validate and print summary without writing files\n`;
}

export function run(options) {
  const taxonomyText = readFileSync(options.taxonomyIn, "utf8");
  const casesText = readFileSync(options.casesIn, "utf8");
  const calibrationText = readFileSync(options.calibration, "utf8");
  const taxonomyDocument = parse(taxonomyText);
  const cases = JSON.parse(casesText);
  const calibration = JSON.parse(calibrationText);
  const result = applyRoutingCalibration({ taxonomyDocument, cases, calibration });

  if (!options.check && !options.taxonomyOut && !options.casesOut) {
    throw new Error("refusing to do nothing: use --check or provide --taxonomy-out/--cases-out");
  }
  if (options.taxonomyOut) atomicWrite(options.taxonomyOut, stringify(result.taxonomy, { lineWidth: 0 }));
  if (options.casesOut) atomicWrite(options.casesOut, `${JSON.stringify(result.cases, null, 2)}\n`);

  return {
    calibrationId: result.calibrationId,
    taxonomyChanges: result.taxonomyChanges,
    caseChanges: result.caseChanges,
    taxonomyOut: options.taxonomyOut,
    casesOut: options.casesOut,
    checkOnly: Boolean(options.check),
  };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      process.stdout.write(`${JSON.stringify(run(options))}\n`);
    }
  } catch (error) {
    console.error(`routing taxonomy calibration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
