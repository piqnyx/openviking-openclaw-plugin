#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "routing/resource-taxonomy.ts"

text = TARGET.read_text(encoding="utf-8")
broken = '  return lines.join("\n");\n'
# `broken` above represents the actually broken TypeScript form: an actual LF
# occurs between the opening and closing quotes. The desired source contains the
# two characters backslash+n inside the TypeScript string literal.
fixed = '  return lines.join("\\n");\n'

count = text.count(broken)
if count != 1:
    raise SystemExit(
        f"repair expected exactly one malformed lines.join string, got {count}; "
        "do not modify the file blindly"
    )

updated = text.replace(broken, fixed, 1)
TARGET.write_text(updated, encoding="utf-8")

print("Repaired routing/resource-taxonomy.ts newline escaping")
print('  return lines.join("\\n");')
