import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { applyRoutingCalibration } from "../tools/routing-taxonomy-apply-calibration.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const taxonomyFile = resolve(repoRoot, "examples/resource-taxonomy.ru.yaml");
const casesFile = resolve(repoRoot, "examples/routing-cases.ru.json");
const calibrationFile = resolve(repoRoot, "examples/resource-taxonomy.ru.calibration.json");

function loadFixture() {
  return {
    taxonomyDocument: parse(readFileSync(taxonomyFile, "utf8")),
    cases: JSON.parse(readFileSync(casesFile, "utf8")),
    calibration: JSON.parse(readFileSync(calibrationFile, "utf8")),
  };
}

function indexCategories(categories, out = new Map()) {
  for (const [key, node] of Object.entries(categories)) {
    out.set(key, node);
    if (node.children) indexCategories(node.children, out);
  }
  return out;
}

function indexCases(cases) {
  return new Map(cases.map((item) => [item.id, item]));
}

describe("Russian resource taxonomy calibration", () => {
  it("applies the reviewed semantic boundary and benchmark-label fixes", () => {
    const result = applyRoutingCalibration(loadFixture());
    const categories = indexCategories(result.taxonomy.categories);
    const cases = indexCases(result.cases);

    expect(result.calibrationId).toBe("ru-routing-calibration-2026-08-12");
    expect(result.taxonomyChanges).toBe(19);
    expect(result.caseChanges).toBe(4);

    expect(categories.get("mine-reminders-todo").description).toContain("актуальные задачи");
    expect(categories.get("mine-scripts-automation").description).toContain("повторяемому триггеру");
    expect(categories.get("mine-scripts-maintenance").distinguishFrom.join(" ")).toContain("cron-задачи");
    expect(categories.get("mine-photos-screenshots").description).toContain("stack trace");
    expect(categories.get("docs-guides-howtos").description).toContain("как выполнить конкретную задачу");
    expect(categories.get("docs-papers-academic").description).toContain("формально опубликованные");
    expect(categories.get("docs-papers-preprints").distinguishFrom.join(" ")).toContain("формально опубликованная");
    expect(categories.get("docs-project-architecture").distinguishFrom.join(" ")).toContain("web/docs/official");
    expect(categories.get("docs-courses-lecture-notes").description).toContain("Авторские учебные конспекты");
    expect(categories.get("docs-operations-runbooks").distinguishFrom.join(" ")).toContain("disaster recovery");
    expect(categories.get("web-articles-technical").description).toContain("веб-статьи");
    expect(categories.get("web-articles-news").distinguishFrom.join(" ")).toContain("release notes");
    expect(categories.get("data-logs-application").distinguishFrom.join(" ")).toContain("data/logs/error");
    expect(categories.get("data-logs-error").distinguishFrom.join(" ")).toContain("mine/photos/screenshots");

    expect(cases.get("rfc").expected).toBe("docs-project-proposals");
    expect(cases.get("inbox-binary").expected).toBe("archives-packages-installers");
    expect(cases.get("academic-paper").summary).toContain("Рецензируемая и формально опубликованная");
    expect(cases.get("app-log").summary).toContain("не специализированный error log");
  });

  it("is idempotent when the same calibration is applied twice", () => {
    const first = applyRoutingCalibration(loadFixture());
    const second = applyRoutingCalibration({
      taxonomyDocument: first.taxonomy,
      cases: first.cases,
      calibration: loadFixture().calibration,
    });

    expect(second.taxonomy).toEqual(first.taxonomy);
    expect(second.cases).toEqual(first.cases);
  });
});
