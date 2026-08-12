#!/usr/bin/env python3
from pathlib import Path

path = Path("examples/resource-taxonomy.ru.yaml")
text = path.read_text(encoding="utf-8")
replacements = {
    "CI/CD pipelines для GitHub Actions, GitLab CI, Jenkins и аналогов.":
        "Конфигурации и определения конвейеров непрерывной интеграции и доставки (CI/CD) для GitHub Actions, GitLab CI, Jenkins и аналогичных систем.",
    "Package manifests и lock-файлы: package.json, pyproject, Cargo.toml, go.mod и аналоги.":
        "Манифесты пакетов и файлы фиксации зависимостей для менеджеров пакетов и систем сборки, включая package.json, pyproject, Cargo.toml, go.mod и аналоги.",
    "Ansible playbooks, roles и inventory-файлы.":
        "Конфигурации автоматизации Ansible с playbook-файлами, ролями и описаниями inventory для управления узлами и развёртывания.",
}
for old, new in replacements.items():
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one taxonomy description match, got {count}: {old!r}")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print(f"Rewrote {len(replacements)} final taxonomy descriptions in Russian")
