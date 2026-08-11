import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync("skills/openviking-context-database/SKILL.md", "utf8");

function section(name: string, nextName: string): string {
  const start = skill.indexOf(`### \`${name}\``);
  const end = skill.indexOf(`### \`${nextName}\``, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return skill.slice(start, end);
}

describe("embedded OpenViking agent skill mutation contract", () => {
  it("documents add_resource as asynchronous without agent wait/timeout parameters", () => {
    const text = section("add_resource", "add_skill");
    expect(text).not.toContain("| `wait` |");
    expect(text).not.toContain("| `timeout` |");
    expect(text).toContain("wait=false");
    expect(text).toContain("outcome-unknown");
    expect(text).toContain("never repeat the same import automatically");
  });

  it("documents add_skill as asynchronous without agent wait/timeout parameters", () => {
    const text = section("add_skill", "remove_resource");
    expect(text).not.toContain("| `wait` |");
    expect(text).not.toContain("| `timeout` |");
    expect(text).toContain("wait=false");
    expect(text).toContain("Manual slash-command and low-level client paths keep explicit `wait`/`timeout`");
  });

  it("documents guarded asynchronous remove_resource behavior", () => {
    const text = section("remove_resource", "ov_search");
    expect(text).toContain("enableRemoveResourceTool=true");
    expect(text).toContain("| `uri` | Yes |");
    expect(text).toContain("| `recursive` | No |");
    expect(text).not.toContain("| `wait` |");
    expect(text).not.toContain("| `timeout` |");
    expect(text).toContain("semantic_status=queued");
    expect(text).toContain("NOT_FOUND");
    expect(text).toContain("never repeat the delete automatically");
  });

  it("keeps synchronous wait controls documented for manual slash commands", () => {
    expect(skill).toContain("/add-resource ./README.md --to viking://resources/openviking-readme --wait");
    expect(skill).toContain("/add-skill ./skills/openviking-context-database --wait --timeout=30");
  });
});
