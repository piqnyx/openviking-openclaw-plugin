#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Apply reviewed one-shot refinements to generated Russian routing examples."
    )
    parser.add_argument("taxonomy", type=Path)
    parser.add_argument("cases", type=Path)
    parser.add_argument(
        "--refinements",
        type=Path,
        default=Path(__file__).with_name("russian-taxonomy-refinements.json"),
    )
    args = parser.parse_args()

    taxonomy_bytes = args.taxonomy.read_bytes()
    cases_bytes = args.cases.read_bytes()
    taxonomy = taxonomy_bytes.decode("utf-8")
    cases = json.loads(cases_bytes.decode("utf-8"))
    refinements = json.loads(args.refinements.read_text(encoding="utf-8"))

    if not isinstance(cases, list):
        raise SystemExit("routing cases must be a JSON array")

    for index, replacement in enumerate(refinements["descriptionReplacements"]):
        old = replacement["old"]
        new = replacement["new"]
        count = taxonomy.count(old)
        if count != 1:
            raise SystemExit(
                f"description replacement #{index + 1}: expected exactly one old description, got {count}: {old!r}"
            )
        taxonomy = taxonomy.replace(old, new, 1)

    existing_ids = {case.get("id") for case in cases if isinstance(case, dict)}
    for case in refinements["additionalCases"]:
        case_id = case["id"]
        if case_id in existing_ids:
            raise SystemExit(f"duplicate routing case id: {case_id}")
        existing_ids.add(case_id)
        cases.append(case)

    final_taxonomy = taxonomy.encode("utf-8")
    final_cases = (json.dumps(cases, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    args.taxonomy.write_bytes(final_taxonomy)
    args.cases.write_bytes(final_cases)

    print("Applied reviewed Russian taxonomy refinements")
    print(f"  taxonomy replacements: {len(refinements['descriptionReplacements'])}")
    print(f"  added routing cases: {len(refinements['additionalCases'])}")
    print(f"  taxonomy sha256: {sha256(taxonomy_bytes)} -> {sha256(final_taxonomy)}")
    print(f"  cases sha256: {sha256(cases_bytes)} -> {sha256(final_cases)}")
    print(f"  total routing cases: {len(cases)}")


if __name__ == "__main__":
    main()
