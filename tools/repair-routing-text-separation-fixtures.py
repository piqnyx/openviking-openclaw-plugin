#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST = ROOT / "tests/add-resource-routing-tool.test.ts"

text = TEST.read_text(encoding="utf-8")
replacements = [
    (
        '{ key: "docs-guides-howtos", path: "docs/guides/howtos", embeddingText: "Практические инструкции", score: 0.82 },',
        '{ key: "docs-guides-howtos", path: "docs/guides/howtos", embeddingText: "Практические инструкции", rerankText: "Практические инструкции", score: 0.82 },',
    ),
    (
        '{ key: "docs-guides-tutorials", path: "docs/guides/tutorials", embeddingText: "Учебные руководства", score: 0.79 },',
        '{ key: "docs-guides-tutorials", path: "docs/guides/tutorials", embeddingText: "Учебные руководства", rerankText: "Учебные руководства", score: 0.79 },',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one migrated fixture match, got {count}: {old}")
    text = text.replace(old, new, 1)

TEST.write_text(text, encoding="utf-8")
print("Repaired migrated add_resource routing candidate fixtures")
