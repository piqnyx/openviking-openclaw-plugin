import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, before, after) {
  const text = await readFile(path, "utf8");
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`${path}: hardening anchor not found:\n${before}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`${path}: hardening anchor not unique:\n${before}`);
  await writeFile(path, text.slice(0, first) + after + text.slice(first + before.length), "utf8");
}

await replaceOnce(
  "resource-routing/config.ts",
  '  label: string,\n): ParsedResourceRoutingEndpoint {\n  const record = asRecord(value, label);\n  assertAllowedKeys(record, ["baseUrl", "endpointPath", "apiKey", "headers", "model", "timeoutMs", "dimensions"], label);',
  '  label: string,\n  extraAllowedKeys: readonly string[] = [],\n): ParsedResourceRoutingEndpoint {\n  const record = asRecord(value, label);\n  assertAllowedKeys(\n    record,\n    ["baseUrl", "endpointPath", "apiKey", "headers", "model", "timeoutMs", ...extraAllowedKeys],\n    label,\n  );',
);

await replaceOnce(
  "resource-routing/config.ts",
  '    "openviking config resourceRouting.embedding",\n  );\n  const reranker = parseEndpoint(',
  '    "openviking config resourceRouting.embedding",\n    ["dimensions"],\n  );\n  const reranker = parseEndpoint(',
);

await replaceOnce(
  "resource-routing/agent-paths.ts",
  'import { isAbsolute, join, resolve } from "node:path";',
  'import { join, resolve } from "node:path";',
);

await replaceOnce(
  "resource-routing/agent-paths.ts",
  '  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);',
  '  return resolve(expanded);',
);
