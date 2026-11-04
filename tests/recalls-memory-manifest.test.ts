import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(join(process.cwd(), "openclaw.plugin.json"), "utf8")) as {
  contracts?: { tools?: string[] };
  toolMetadata?: Record<string, { recallsMemory?: unknown }>;
};

// The gateway's day chronicle does not retell recalled memory as the day's events: the tools that
// bring back earlier memories, archived messages and earlier tool results say so in the manifest
// (OpenClaw `recallsMemory`). Resource and skill search is not memory and stays unmarked.
describe("tool metadata in the manifest", () => {
  it("marks the tools that recall memory, and only them", () => {
    const recalling = Object.entries(manifest.toolMetadata ?? {})
      .filter(([, metadata]) => metadata?.recallsMemory === true)
      .map(([name]) => name)
      .sort();
    expect(recalling).toEqual([
      "memory_recall",
      "openviking_tool_result_list",
      "openviking_tool_result_read",
      "openviking_tool_result_search",
      "ov_archive_expand",
      "ov_archive_search",
      "ov_recall_trace",
    ]);
    for (const name of Object.keys(manifest.toolMetadata ?? {})) {
      expect(manifest.contracts?.tools ?? []).toContain(name);
    }
  });
});
