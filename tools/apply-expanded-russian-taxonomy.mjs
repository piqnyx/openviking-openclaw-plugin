#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse, stringify } from "yaml";

const EXPECTED_REFINED_SHA256 = "284fb0def4a078f2961d81a836f9396449fffa2eabc6e0f7166b1f27b986a31c";
const SENTINEL_KEY = "media";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function findEntry(children, wantedKey) {
  for (const [key, raw] of Object.entries(children)) {
    const node = asRecord(raw, `category ${key}`);
    if (key === wantedKey) return { key, node, children };
    if (node.children !== undefined) {
      const found = findEntry(asRecord(node.children, `category ${key}.children`), wantedKey);
      if (found) return found;
    }
  }
  return undefined;
}

function getEntry(document, key) {
  const found = findEntry(document.categories, key);
  if (!found) throw new Error(`taxonomy category ${JSON.stringify(key)} not found`);
  return found;
}

function getNode(document, key) {
  return getEntry(document, key).node;
}

function childMap(document, parentKey) {
  if (parentKey === null) return document.categories;
  const parent = getNode(document, parentKey);
  if (parent.children === undefined) parent.children = {};
  return asRecord(parent.children, `category ${parentKey}.children`);
}

function addNode(document, parentKey, key, node) {
  if (findEntry(document.categories, key)) {
    throw new Error(`refusing to overwrite existing category key ${JSON.stringify(key)}`);
  }
  childMap(document, parentKey)[key] = node;
}

function addStructural(document, parentKey, key, segment, description) {
  addNode(document, parentKey, key, {
    segment,
    description,
    routeable: false,
    children: {},
  });
}

function addLeaf(document, parentKey, key, segment, description, distinguishFrom = undefined) {
  const node = { segment, description };
  if (distinguishFrom?.length) node.distinguishFrom = distinguishFrom;
  addNode(document, parentKey, key, node);
}

function detach(document, key) {
  const found = getEntry(document, key);
  delete found.children[key];
  return found.node;
}

function move(document, key, newParentKey, options = {}) {
  const node = detach(document, key);
  if (options.segment) node.segment = options.segment;
  if (options.description) node.description = options.description;
  if (options.distinguishFrom) node.distinguishFrom = options.distinguishFrom;
  const target = childMap(document, newParentKey);
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new Error(`destination already contains ${key}`);
  }
  target[key] = node;
}

function define(document, key, description, distinguishFrom = undefined) {
  const node = getNode(document, key);
  node.description = description;
  if (distinguishFrom?.length) node.distinguishFrom = distinguishFrom;
  else delete node.distinguishFrom;
}

function hint(document, key, distinguishFrom) {
  const node = getNode(document, key);
  node.distinguishFrom = distinguishFrom;
}

function appendCases(cases, additions) {
  const ids = new Set(cases.map((entry) => entry?.id));
  for (const item of additions) {
    if (ids.has(item.id)) throw new Error(`routing case ${item.id} already exists`);
    ids.add(item.id);
    cases.push(item);
  }
}

function deepenMine(document) {
  getNode(document, "mine-passwords").segment = "secrets";
  define(
    document,
    "mine-passwords",
    "Личные секреты и материалы доступа пользователя: учётные данные, токены, криптографические ключи и сертификаты.",
  );
  define(document, "mine-configs-dotfiles-ssh", "Пользовательская конфигурация SSH: hosts, aliases, connection options и параметры клиента.", [
    "Приватные SSH-ключи и чувствительные материалы доступа относятся к mine/secrets/ssh.",
  ]);
  define(document, "mine-configs-kubernetes", "Личные Kubernetes manifests, контексты и эксплуатационные настройки собственных кластеров.", [
    "Секретные токены и credentials не относятся к конфигурационной ветке и должны храниться среди личных секретов.",
    "Kubernetes manifests, являющиеся частью программного репозитория или infrastructure-as-code проекта, относятся к code/infrastructure/kubernetes.",
  ]);
  define(document, "mine-configs-package-manager", "Настройки package managers и registries программного проекта.");

  addStructural(document, "mine", "mine-records", "records", "Личные записи и документы пользователя о личности, финансах, здоровье, поездках, работе, образовании и покупках.");

  addStructural(document, "mine-records", "mine-records-identity", "identity", "Официальные и идентификационные документы, а также персональные контактные сведения пользователя.");
  addLeaf(document, "mine-records-identity", "mine-records-identity-documents", "documents", "Паспорта, удостоверения, свидетельства и другие официальные документы, подтверждающие личность или гражданское состояние.");
  addLeaf(document, "mine-records-identity", "mine-records-contacts", "contacts", "Личные адресные книги, vCard-файлы и структурированные контактные сведения.");

  addStructural(document, "mine-records", "mine-records-finance", "finance", "Личные финансовые документы, платежи, банковские записи и налоговые материалы пользователя.");
  addLeaf(document, "mine-records-finance", "mine-records-receipts", "receipts", "Кассовые и электронные чеки, подтверждающие личные покупки и платежи.");
  addLeaf(document, "mine-records-finance", "mine-records-invoices", "invoices", "Счета на оплату и инвойсы, выставленные пользователю или сохранённые для личного учёта.");
  addLeaf(document, "mine-records-finance", "mine-records-banking", "banking", "Банковские выписки, отчёты по счетам и другие личные банковские документы.");
  addLeaf(document, "mine-records-finance", "mine-records-taxes", "taxes", "Налоговые декларации, расчёты, уведомления и подтверждающие документы пользователя.");
  addLeaf(document, "mine-records-finance", "mine-records-subscriptions", "subscriptions", "Записи о личных подписках, тарифах, регулярных платежах и сроках продления.");

  addStructural(document, "mine-records", "mine-records-health", "health", "Личные медицинские документы и сведения о здоровье пользователя.");
  addLeaf(document, "mine-records-health", "mine-records-medical", "medical-records", "Медицинские заключения, выписки, истории обращений и другие клинические документы пользователя.");
  addLeaf(document, "mine-records-health", "mine-records-labs", "lab-results", "Результаты лабораторных анализов, исследований и диагностических измерений пользователя.");
  addLeaf(document, "mine-records-health", "mine-records-prescriptions", "prescriptions", "Рецепты, назначения лекарств и схемы лечения пользователя.");

  addStructural(document, "mine-records", "mine-records-travel", "travel", "Личные документы поездок, маршруты, бронирования и транспортные билеты.");
  addLeaf(document, "mine-records-travel", "mine-records-itineraries", "itineraries", "Маршруты и планы личных поездок с последовательностью мест, дат и действий.");
  addLeaf(document, "mine-records-travel", "mine-records-bookings", "bookings", "Подтверждения бронирований жилья, транспорта, мероприятий и других услуг для поездок.");
  addLeaf(document, "mine-records-travel", "mine-records-tickets", "tickets", "Билеты и посадочные документы на самолёты, поезда, автобусы, мероприятия и другие поездки.");

  addStructural(document, "mine-records", "mine-records-career", "career", "Личные документы карьеры, поиска работы и трудовых отношений.");
  addLeaf(document, "mine-records-career", "mine-records-resumes", "resumes", "Резюме, CV и профессиональные профили пользователя.");
  addLeaf(document, "mine-records-career", "mine-records-employment", "employment", "Трудовые предложения, кадровые документы и записи о занятости пользователя.");

  addStructural(document, "mine-records", "mine-records-education", "education", "Личные документы об обучении, квалификации и академических результатах.");
  addLeaf(document, "mine-records-education", "mine-records-certificates", "certificates", "Дипломы, сертификаты о прохождении обучения и документы о квалификации пользователя.");
  addLeaf(document, "mine-records-education", "mine-records-transcripts", "transcripts", "Академические ведомости, приложения к диплому и другие записи об образовательных результатах.");

  addStructural(document, "mine-records", "mine-records-purchases", "purchases", "Документы о личных покупках, заказах и гарантийных обязательствах.");
  addLeaf(document, "mine-records-purchases", "mine-records-orders", "orders", "Подтверждения заказов и карточки приобретённых товаров или услуг.");
  addLeaf(document, "mine-records-purchases", "mine-records-warranties", "warranties", "Гарантийные талоны, условия гарантии и подтверждения сервисного обслуживания личных покупок.");
}

function deepenDocs(document) {
  addStructural(document, "docs-project", "docs-project-design", "design", "Проектные документы о техническом устройстве, решениях и предлагаемых изменениях системы.");
  move(document, "docs-project-architecture", "docs-project-design");
  move(document, "docs-project-internals", "docs-project-design");
  addLeaf(document, "docs-project-design", "docs-project-adrs", "adrs", "Architecture Decision Records с контекстом, принятым техническим решением и его последствиями.");
  addLeaf(document, "docs-project-design", "docs-project-proposals", "proposals", "Проектные RFC, design proposals и технические предложения изменений до или во время реализации.", [
    "Формальные внешние стандарты и общие протокольные RFC относятся к docs/specifications.",
  ]);

  addStructural(document, "docs-project", "docs-project-planning", "planning", "Проектные требования, планы развития и документы планирования реализации.");
  move(document, "docs-project-requirements", "docs-project-planning");
  move(document, "docs-project-roadmap", "docs-project-planning");

  addStructural(document, "docs-project", "docs-project-releases", "releases", "Документация истории изменений и отдельных выпусков программного проекта.");
  move(document, "docs-project-changelog", "docs-project-releases");
  move(document, "docs-project-release-notes", "docs-project-releases");

  addStructural(document, "docs", "docs-operations", "operations", "Авторские эксплуатационные документы: runbooks, процедуры, чек-листы и планы восстановления систем.");
  addLeaf(document, "docs-operations", "docs-operations-runbooks", "runbooks", "Пошаговые runbooks для повторяемых эксплуатационных операций, диагностики и восстановления сервисов.");
  addLeaf(document, "docs-operations", "docs-operations-procedures", "procedures", "Стандартные операционные процедуры и регламентированные последовательности действий.");
  addLeaf(document, "docs-operations", "docs-operations-checklists", "checklists", "Операционные чек-листы для запуска, проверки, релиза, обслуживания или завершения работ.");
  addLeaf(document, "docs-operations", "docs-operations-recovery", "disaster-recovery", "Планы аварийного восстановления, восстановления после потери данных и возврата критичных сервисов в рабочее состояние.");

  addStructural(document, "docs", "docs-meetings", "meetings", "Авторские документы встреч: повестки, протоколы и зафиксированные решения, а не дословные расшифровки речи.");
  addLeaf(document, "docs-meetings", "docs-meetings-agendas", "agendas", "Повестки встреч с целями, вопросами для обсуждения и запланированным порядком работы.");
  addLeaf(document, "docs-meetings", "docs-meetings-minutes", "minutes", "Протоколы и структурированные заметки встреч с обсуждёнными вопросами, выводами и итогами.", [
    "Дословные расшифровки разговоров относятся к comms/transcripts/meetings.",
  ]);
  addLeaf(document, "docs-meetings", "docs-meetings-decisions", "decisions", "Зафиксированные решения встреч с выбранным вариантом, ответственными лицами и контекстом принятия решения.");

  addStructural(document, "docs", "docs-presentations", "presentations", "Презентационные материалы, подготовленные для показа аудитории.");
  addLeaf(document, "docs-presentations", "docs-presentations-slides", "slides", "Слайды презентаций и докладов в PDF, PPTX или другом презентационном формате.");
  addLeaf(document, "docs-presentations", "docs-presentations-speaker-notes", "speaker-notes", "Подготовленные заметки и тезисы выступающего, сопровождающие презентацию или доклад.");

  addStructural(document, "docs", "docs-templates", "templates", "Шаблоны документов и формы для повторного заполнения или создания однотипных материалов.");
  addLeaf(document, "docs-templates", "docs-templates-documents", "documents", "Шаблоны писем, отчётов, спецификаций, заметок и других документов.");
  addLeaf(document, "docs-templates", "docs-templates-forms", "forms", "Пустые или типовые формы, анкеты и бланки, предназначенные для последующего заполнения.");

  addLeaf(document, "docs-papers", "docs-papers-theses", "theses", "Диссертации, дипломные исследования и другие крупные академические квалификационные работы.");

  for (const languageKey of ["docs-languages-javascript", "docs-languages-python", "docs-languages-go", "docs-languages-rust", "docs-languages-shell", "docs-languages-cpp", "docs-languages-java", "docs-languages-sql"]) {
    hint(document, languageKey, ["Исходный код программного проекта на этом языке относится к соответствующей категории code/source."]);
  }
  define(document, "docs-languages-javascript", "Учебные и справочные материалы по JavaScript и TypeScript: язык, платформы, библиотеки, idioms и практические примеры.", getNode(document, "docs-languages-javascript").distinguishFrom);
  define(document, "docs-languages-python", "Учебные и справочные материалы по Python: язык, стандартная библиотека, idioms и практические примеры.", getNode(document, "docs-languages-python").distinguishFrom);
  define(document, "docs-languages-go", "Учебные и справочные материалы по Go: язык, стандартная библиотека, idioms и практические примеры.", getNode(document, "docs-languages-go").distinguishFrom);
  define(document, "docs-languages-rust", "Учебные и справочные материалы по Rust: язык, стандартная библиотека, idioms и практические примеры.", getNode(document, "docs-languages-rust").distinguishFrom);
  define(document, "docs-languages-cpp", "Учебные и справочные материалы по C и C++: язык, библиотеки, idioms и практические примеры.", getNode(document, "docs-languages-cpp").distinguishFrom);

  define(document, "docs-reports-research", "Готовые самостоятельные исследовательские отчёты с методикой, данными, анализом и выводами.", ["Рабочие заметки, измерения и предварительные оценки собственного исследования относятся к mine/research."]);
  define(document, "docs-reports-benchmarks", "Готовые самостоятельные отчёты о сравнительных тестах производительности и характеристик с методикой, измерениями и выводами.", [
    "Исполняемый benchmark-код относится к code/tests/benchmarks.",
    "Промежуточные рабочие результаты собственных измерений относятся к mine/research/benchmarks.",
  ]);
  define(document, "docs-reports-incidents", "Завершённые отчёты об инцидентах и postmortem с timeline, impact, root cause и corrective actions.", ["Операционные материалы активного реагирования относятся к security/incidents/incident-response."]);
  hint(document, "docs-reports-audits", ["Рабочие технические материалы penetration testing до итогового отчёта относятся к security/assessment/pentest."]);
}

function deepenCode(document) {
  for (const [key, label] of [
    ["code-source-javascript", "JavaScript и TypeScript, включая Node.js и браузерные приложения"],
    ["code-source-python", "Python"],
    ["code-source-go", "Go"],
    ["code-source-rust", "Rust"],
    ["code-source-cpp", "C или C++"],
    ["code-source-java", "Java или Kotlin"],
    ["code-source-php-ruby", "PHP или Ruby"],
  ]) {
    define(document, key, `Исходный код программных проектов, сервисов и библиотек на ${label}.`, ["Учебные и справочные материалы о языке относятся к docs/languages."]);
  }
  define(document, "code-source-shell", "Shell-код Bash, Zsh, POSIX sh и подобных языков командной оболочки, являющийся частью исходного дерева программного проекта.", ["Самостоятельные административные и эксплуатационные скрипты пользователя относятся к mine/scripts."]);
  addLeaf(document, "code-source", "code-source-notebooks", "notebooks", "Исполняемые Jupyter, Marimo и другие notebook-документы, объединяющие код, вычисления и пояснения в программной работе.");
  addLeaf(document, "code-source", "code-source-generated", "generated", "Сгенерированный исходный код, автоматически произведённый компиляторами схем, генераторами клиентов или build-процессом.");
  addLeaf(document, "code-source", "code-source-migrations", "migrations", "Миграции схемы или данных базы, являющиеся частью исходного дерева и процесса развёртывания приложения.");

  addStructural(document, "code-build", "code-build-containers", "containers", "Проектные файлы контейнерной сборки и локального многоконтейнерного запуска.");
  move(document, "code-build-dockerfiles", "code-build-containers");
  move(document, "code-build-compose", "code-build-containers");
  addLeaf(document, "code-build-containers", "code-build-devcontainers", "devcontainers", "Dev Container и container-based development environment конфигурации программного проекта.");
  hint(document, "code-build-compose", ["Эксплуатационный Compose собственных уже развёрнутых сервисов пользователя относится к mine/configs/docker."]);

  addStructural(document, "code-build", "code-build-tooling", "tooling", "Системы сборки, dependency manifests и инструменты управления проектной сборкой.");
  move(document, "code-build-make", "code-build-tooling");
  move(document, "code-build-packages", "code-build-tooling");
  addLeaf(document, "code-build-tooling", "code-build-bazel-meson", "bazel-meson", "Bazel, Meson и другие декларации систем сборки, не относящиеся к Make или CMake.");

  addStructural(document, "code", "code-infrastructure", "infrastructure", "Infrastructure-as-code и декларативные конфигурации инфраструктуры, хранящиеся как программный проект.");
  move(document, "code-build-terraform", "code-infrastructure");
  move(document, "code-build-ansible", "code-infrastructure");
  addLeaf(document, "code-infrastructure", "code-infrastructure-kubernetes", "kubernetes", "Kubernetes manifests и Kustomize-конфигурации, являющиеся частью infrastructure-as-code или программного репозитория.", ["Личные эксплуатационные настройки собственных кластеров вне проекта относятся к mine/configs/kubernetes."]);
  addLeaf(document, "code-infrastructure", "code-infrastructure-helm", "helm", "Helm charts, values и шаблоны Kubernetes-пакетов в infrastructure-as-code проекте.");
  addLeaf(document, "code-infrastructure", "code-infrastructure-pulumi", "pulumi", "Pulumi programs и конфигурации управления инфраструктурой как кодом.");
  addLeaf(document, "code-infrastructure", "code-infrastructure-nix", "nix", "Nix, NixOS, flakes и Home Manager декларации, используемые как infrastructure/configuration-as-code.");

  addLeaf(document, "code-config", "code-config-environment", "environment", "Проектные environment templates и несекретные переменные окружения, определяющие runtime-настройки приложения.");
  addLeaf(document, "code-config", "code-config-feature-flags", "feature-flags", "Проектные декларации feature flags, экспериментальных переключателей и управляемых runtime-возможностей.");

  define(document, "code-config-package-manager", "Настройки package managers и registries, являющиеся частью программного проекта.", ["Секретные registry credentials и access tokens относятся к личным секретам, а не к проектной конфигурации."]);
}

function deepenWeb(document) {
  addStructural(document, "web-articles", "web-articles-editorial", "editorial", "Одиночные веб-публикации, классифицируемые прежде всего по редакционному типу материала.");
  for (const key of ["web-articles-technical", "web-articles-news", "web-articles-blogs"]) move(document, key, "web-articles-editorial");
  addStructural(document, "web-articles", "web-articles-platforms", "platforms", "Одиночные публикации, для которых издательская платформа является полезной частью классификации.");
  for (const key of ["web-articles-habr", "web-articles-medium", "web-articles-substack"]) move(document, key, "web-articles-platforms");

  addStructural(document, "web", "web-discussions", "discussions", "Одиночные сохранённые веб-дискуссии, вопросы, ответы и обсуждения на публичных площадках.");
  move(document, "web-articles-reddit", "web-discussions");
  move(document, "web-articles-forums", "web-discussions");
  addLeaf(document, "web-discussions", "web-discussions-stackoverflow", "stackoverflow", "Одиночные сохранённые вопросы и ответы Stack Overflow, Stack Exchange и аналогичных Q&A-площадок.");
  addLeaf(document, "web-discussions", "web-discussions-issues", "issue-trackers", "Одиночные сохранённые публичные issue, bug tracker или pull-request страницы с обсуждением и техническим контекстом.", ["Массовые или структурированные экспорты рабочих issue/PR обсуждений относятся к comms/collaboration."]);

  addStructural(document, "web", "web-docs", "docs", "Одиночные сохранённые страницы онлайн-документации и веб-справки, не являющиеся пакетным scraping результатом.");
  addLeaf(document, "web-docs", "web-docs-official", "official", "Одиночные сохранённые страницы официальной документации продукта, библиотеки, API или сервиса.", ["Пакетно извлечённая crawler-ом документация относится к web/scraped/docs.", "Локальная проектная документация относится к docs/project."]);
  addLeaf(document, "web-docs", "web-docs-wiki", "wiki", "Одиночные сохранённые энциклопедические, wiki и collaboratively-edited справочные страницы.");
  addLeaf(document, "web-docs", "web-docs-reference", "reference", "Одиночные веб-справочники, таблицы параметров и reference-страницы для быстрого обращения.");
  addLeaf(document, "web-docs", "web-docs-knowledge-base", "knowledge-base", "Одиночные статьи базы знаний, help center и support documentation веб-сервисов.");
  addLeaf(document, "web", "web-feeds", "feeds", "Сохранённые RSS, Atom и другие веб-ленты публикаций как самостоятельные ресурсы.");

  define(document, "web-scraped", "Результаты автоматического пакетного scraping или crawling веб-сайтов, где происхождение из crawler-процесса существенно для типа ресурса.", ["Одиночные сохранённые URL-страницы относятся к web/pages, web/docs, web/articles или web/discussions по их типу."]);
  define(document, "web-scraped-docs", "Документация, полученная как результат автоматического пакетного scraping или crawling веб-сайта.", ["Одиночная сохранённая страница онлайн-документации относится к web/docs.", "Обычный локальный проектный документ относится к docs/project."]);
  define(document, "web-pages-saved", "Одиночные сохранённые текущие версии веб-страниц общего назначения.", ["Статьи, дискуссии и страницы онлайн-документации относятся к соответствующим более специальным web-веткам; пакетный crawling относится к web/scraped."]);
  hint(document, "web-articles-substack", ["Письмо рассылки, доставленное по email, относится к comms/email/newsletters."]);
  hint(document, "web-articles-forums", ["Массовый экспорт истории форума с множеством тем относится к comms/forum-exports."]);
}

function deepenComms(document) {
  addStructural(document, "comms", "comms-collaboration", "collaboration", "Структурированные экспорты рабочих обсуждений из issue trackers, code review и support/helpdesk систем.");
  addLeaf(document, "comms-collaboration", "comms-collaboration-issues", "issues", "Экспорты рабочих issues и bug reports с историей комментариев, статусами и метаданными задачи.", ["Одиночная сохранённая публичная issue-страница относится к web/discussions/issue-trackers."]);
  addLeaf(document, "comms-collaboration", "comms-collaboration-pull-requests", "pull-requests", "Экспорты pull request или merge request обсуждений с review comments, решениями и историей изменений.");
  addLeaf(document, "comms-collaboration", "comms-collaboration-support", "support-tickets", "Экспорты helpdesk и support tickets с перепиской, статусами, участниками и историей обработки обращения.");

  addLeaf(document, "comms-messaging", "comms-teams", "teams", "Экспорты чатов, каналов и переписки из Microsoft Teams.");
  addLeaf(document, "comms-messaging", "comms-mattermost", "mattermost", "Экспорты каналов и переписки из Mattermost.");
  addLeaf(document, "comms-messaging", "comms-irc", "irc", "Логи и экспорты разговоров из IRC-каналов и приватных IRC-сообщений.");
  addLeaf(document, "comms-messaging", "comms-zulip", "zulip", "Экспорты streams, topics и сообщений из Zulip.");

  addLeaf(document, "comms-transcripts", "comms-transcripts-podcasts", "podcasts", "Текстовые расшифровки подкастов и записанных разговорных выпусков.");
  addLeaf(document, "comms-transcripts", "comms-transcripts-voice-notes", "voice-notes", "Текстовые расшифровки голосовых заметок и коротких аудиосообщений.");
  hint(document, "comms-transcripts-meetings", ["Авторский протокол или структурированные итоги встречи относятся к docs/meetings/minutes, а не к дословным transcript-материалам."]);
  define(document, "comms-forums", "Массовые экспорты истории форумов с несколькими темами, комментариями, авторами и временными метаданными.", ["Одиночная сохранённая веб-тема форума относится к web/discussions/forums."]);
  define(document, "comms-transcripts-talks", "Текстовые расшифровки произнесённых лекций, докладов, презентаций и публичных выступлений.", ["Авторские конспекты лекций относятся к docs/courses/lecture-notes.", "Исходное аудио или видео выступления относится к media."]);
}

function deepenData(document) {
  addStructural(document, "data", "data-network", "network", "Сырые и структурированные данные сетевого трафика, HTTP-сеансов и сетевых наблюдений.");
  addLeaf(document, "data-network", "data-network-pcap", "pcap", "PCAP/PCAPNG захваты сетевых пакетов и другие packet-capture файлы.");
  addLeaf(document, "data-network", "data-network-har", "har", "HTTP Archive (HAR) файлы с запросами, ответами, таймингами и ресурсами браузерных или API-сеансов.");
  addLeaf(document, "data-network", "data-network-flows", "flows", "NetFlow, IPFIX и другие агрегированные записи сетевых потоков и соединений.");

  addStructural(document, "data", "data-crash", "crash", "Технические артефакты сбоев процессов и снимки памяти для диагностики ошибок.");
  addLeaf(document, "data-crash", "data-crash-core", "core-dumps", "Core dumps и другие снимки памяти упавших процессов для отладки.");
  addLeaf(document, "data-crash", "data-crash-heap", "heap-dumps", "Heap dumps и снимки управляемой памяти процессов для анализа утечек и потребления памяти.");
  addLeaf(document, "data-crash", "data-crash-reports", "crash-reports", "Структурированные crash reports с stack traces, signal/exception metadata и состоянием процесса при сбое.");

  addStructural(document, "data", "data-ml", "ml", "Машиночитаемые артефакты ML/AI систем: модели, embeddings и векторные индексы.");
  addLeaf(document, "data-ml", "data-ml-checkpoints", "checkpoints", "Model checkpoints, веса, adapters и другие сохраняемые состояния ML-моделей.");
  addLeaf(document, "data-ml", "data-ml-embeddings", "embeddings", "Экспорты embedding-векторов и связанные таблицы векторных представлений объектов.");
  addLeaf(document, "data-ml", "data-ml-vector-indexes", "vector-indexes", "Экспорты и файлы векторных индексов или коллекций vector database, сохраняемые как технические данные.");
  addLeaf(document, "data-observability", "data-observability-alerts", "alerts", "Экспорты событий мониторинговых alerts, срабатываний правил и связанных временных меток.");

  define(document, "data-datasets-json", "Структурированные наборы данных в JSON или построчном JSONL для анализа, обучения или машинной обработки.", ["JSON-конфигурация приложения относится к code/config/application."]);
  define(document, "data-datasets-yaml", "Структурированные наборы данных и каталоги в YAML, используемые как данные для анализа, обучения или машинной обработки.", ["YAML-конфигурация программного проекта относится к code/config/application."]);
  hint(document, "data-dumps-sql", ["SQL-код запросов и хранимых процедур проекта относится к code/source/sql; backup-пакет базы с backup metadata относится к archives/backups/database."]);
}

function deepenArchives(document) {
  addLeaf(document, "archives-packages", "archives-packages-binary", "binary-releases", "Готовые бинарные release bundles и собранные пакеты программ, сохраняемые как распространяемые артефакты.");
  addLeaf(document, "archives-packages", "archives-packages-installers", "installers", "Инсталляторы, установочные пакеты и standalone setup bundles программного обеспечения.");

  addStructural(document, "archives", "archives-images", "images", "Архивные образы контейнеров, виртуальных машин, дисков и установочных носителей.");
  addLeaf(document, "archives-images", "archives-images-containers", "container-images", "Экспортированные OCI/Docker container images и image tar archives.");
  addLeaf(document, "archives-images", "archives-images-vm", "vm-disk-images", "Образы виртуальных машин и виртуальных дисков, включая qcow2, vmdk, vdi и raw disk images.");
  addLeaf(document, "archives-images", "archives-images-iso", "iso", "ISO и другие образы установочных, rescue или оптических носителей.");
  addLeaf(document, "archives-exports", "archives-exports-password-managers", "password-managers", "Полные или пакетные экспорты хранилищ password manager, содержащие записи и метаданные нескольких учётных данных.", ["Отдельные рабочие credentials относятся к mine/secrets; этот класс предназначен именно для целостного export bundle."]);

  define(document, "archives-backups-database", "Архивные backup-пакеты баз данных с метаданными резервного копирования и служебными файлами восстановления.", ["Сырой SQL/NoSQL dump без backup-контейнера относится к data/dumps."]);
  define(document, "archives-packages-source", "ZIP/TAR и release source bundles, сохраняемые как единый архивный пакет исходников.", ["Распакованное дерево исходного кода относится к code/source."]);
}

function addMedia(document) {
  addStructural(document, null, "media", "media", "Изображения, аудио и видео, где основным ресурсом является медиасодержимое, а не текстовая расшифровка или структурированный документ.");
  addStructural(document, "media", "media-images", "images", "Неперсональные или технические изображения: скриншоты, диаграммы, графики, сканы и иллюстрации.");
  move(document, "mine-photos-screenshots", "media-images", { description: "Скриншоты приложений, браузеров, терминалов, интерфейсов и других экранных состояний." });
  move(document, "mine-photos-documents", "media-images", { segment: "scans", description: "Сканы и фотографии бумажных документов, страниц, рукописных записей и печатных материалов как изображения." });
  addLeaf(document, "media-images", "media-images-diagrams", "diagrams", "Диаграммы архитектуры, процессов, сетей, компонентов и других структурированных взаимосвязей.");
  addLeaf(document, "media-images", "media-images-charts", "charts", "Графики, plots, dashboards и визуализации числовых данных, сохраняемые как изображения.");
  addLeaf(document, "media-images", "media-images-illustrations", "illustrations", "Иллюстрации, схемы, рисунки и другие визуальные материалы общего назначения.");
  addLeaf(document, "media-images", "media-images-generated", "generated", "Изображения, созданные генеративными моделями или программными средствами как самостоятельный визуальный результат.");

  addStructural(document, "media", "media-audio", "audio", "Аудиозаписи, где сохраняется исходный звук, речь или музыка.");
  addLeaf(document, "media-audio", "media-audio-recordings", "recordings", "Общие аудиозаписи речи, окружения или событий, не подходящие к более специальному аудиоклассу.");
  addLeaf(document, "media-audio", "media-audio-meetings", "meetings", "Исходные аудиозаписи встреч и групповых обсуждений.", ["Текстовая расшифровка встречи относится к comms/transcripts/meetings."]);
  addLeaf(document, "media-audio", "media-audio-talks", "talks", "Исходные аудиозаписи лекций, докладов и публичных выступлений.", ["Текстовая расшифровка выступления относится к comms/transcripts/talks."]);
  addLeaf(document, "media-audio", "media-audio-podcasts", "podcasts", "Исходные аудиофайлы podcast-выпусков и записанных разговорных программ.", ["Текстовая расшифровка podcast-выпуска относится к comms/transcripts/podcasts."]);
  addLeaf(document, "media-audio", "media-audio-music", "music", "Музыкальные аудиофайлы и записи, сохраняемые как самостоятельное медиасодержимое.");

  addStructural(document, "media", "media-video", "video", "Видеозаписи, screen captures и другие движущиеся визуальные материалы со звуком или без него.");
  addLeaf(document, "media-video", "media-video-screen-recordings", "screen-recordings", "Записи экрана приложений, терминалов, браузеров и демонстраций пользовательского интерфейса.");
  addLeaf(document, "media-video", "media-video-meetings", "meetings", "Исходные видеозаписи встреч, видеоконференций и групповых обсуждений.");
  addLeaf(document, "media-video", "media-video-talks", "talks", "Видеозаписи конференционных докладов, лекций, презентаций и публичных выступлений.");
  addLeaf(document, "media-video", "media-video-tutorials", "tutorials", "Видеообучение и практические tutorial-записи, где основной ресурс представляет собой видео.");
  addLeaf(document, "media-video", "media-video-clips", "clips", "Короткие видеоклипы и фрагменты, не подходящие к более специальной видеокатегории.");

  define(document, "mine-photos", "Личные фотографии пользователя, организованные по содержанию снимка; технические изображения и скриншоты относятся к media/images.");
}

function deepenSecurity(document) {
  addStructural(document, "security", "security-vulnerability-management", "vulnerabilities", "Материалы о конкретных уязвимостях, advisories, результатах обнаружения и техническом анализе риска.");
  move(document, "security-advisories", "security-vulnerability-management");
  move(document, "security-vulnerabilities", "security-vulnerability-management", { segment: "analysis", description: "Технические описания и анализ конкретных уязвимостей, CVE, причин, exploitability и возможного воздействия." });
  addLeaf(document, "security-vulnerability-management", "security-scanner-results", "scanner-results", "Результаты автоматических vulnerability scanners с найденными уязвимостями, версиями компонентов и уровнями серьёзности.");

  addStructural(document, "security", "security-assessment", "assessment", "Рабочие материалы технической оценки защищённости: reconnaissance, scanning и penetration testing.");
  move(document, "security-pentest", "security-assessment", { description: "Рабочие технические материалы penetration testing: scope, evidence, заметки проверки, отдельные findings и PoC." });
  addLeaf(document, "security-assessment", "security-recon", "recon", "Материалы reconnaissance и attack-surface discovery: активы, сервисы, домены, endpoints и собранная техническая информация.");
  addLeaf(document, "security-assessment", "security-scanning", "scanning", "Рабочие результаты портового, сервисного, web и другого технического сканирования в рамках оценки безопасности.");
  hint(document, "security-pentest", ["Готовый формальный итоговый audit report относится к docs/reports/audits."]);

  addStructural(document, "security", "security-defense", "defense", "Материалы защитных мер, безопасной конфигурации, правил обнаружения и контроля доступа.");
  move(document, "security-hardening", "security-defense");
  addLeaf(document, "security-defense", "security-detection-rules", "detection-rules", "Правила обнаружения для SIEM, IDS/IPS, EDR, YARA, Sigma и других defensive detection систем.");
  addLeaf(document, "security-defense", "security-access-control", "access-control", "Материалы политик и технических правил аутентификации, авторизации, RBAC/ACL и управления доступом.");

  addStructural(document, "security", "security-intelligence", "intelligence", "Threat intelligence, indicators of compromise и материалы анализа вредоносной активности.");
  move(document, "security-threat-intel", "security-intelligence");
  addLeaf(document, "security-intelligence", "security-iocs", "iocs", "Наборы indicators of compromise: hashes, domains, IP addresses, URLs, signatures и связанные контекстные сведения.");
  addLeaf(document, "security-intelligence", "security-malware", "malware-analysis", "Технический анализ malware, образцов, поведения, persistence, capabilities и артефактов выполнения.");

  addStructural(document, "security", "security-incidents", "incidents", "Операционные материалы расследования и активного реагирования на инциденты безопасности.");
  move(document, "security-incident-response", "security-incidents", { description: "Операционные материалы активного реагирования на инциденты безопасности: runbooks, playbooks, рабочие действия и координация восстановления." });
  addLeaf(document, "security-incidents", "security-forensics", "forensics", "Digital forensics материалы: forensic images, timelines, артефакты систем и результаты технического расследования инцидента.");
  addLeaf(document, "security-incidents", "security-evidence", "evidence", "Собранные evidence bundles и рабочие доказательные материалы конкретного security incident.");
  hint(document, "security-incident-response", ["Завершённый postmortem и итоговый разбор причин относятся к docs/reports/incidents."]);

  addStructural(document, "security", "security-design", "design", "Проектирование безопасности: архитектура защиты, модели угроз, trust boundaries и security controls.");
  move(document, "security-architecture", "security-design");
  addLeaf(document, "security-design", "security-threat-models", "threat-models", "Threat models с активами, доверительными границами, adversary assumptions, угрозами и предлагаемыми mitigations.");
}

function addCases(cases) {
  appendCases(cases, [
    { id: "adr-project-decision", summary: "ADR проекта фиксирует выбор PostgreSQL вместо MongoDB, контекст решения, альтернативы и технические последствия.", expected: "docs-project-adrs" },
    { id: "ops-runbook", summary: "Runbook восстановления сервиса после падения Redis с проверками health, командами переключения и критериями успешного возврата в работу.", expected: "docs-operations-runbooks" },
    { id: "meeting-minutes-authored", summary: "Структурированный протокол встречи команды с итогами обсуждения, принятыми решениями и ответственными, составленный после разговора.", expected: "docs-meetings-minutes" },
    { id: "meeting-transcript-verbatim", summary: "Дословная текстовая расшифровка рабочей встречи с репликами участников и временными метками.", expected: "comms-transcripts-meetings" },
    { id: "project-notebook", summary: "Jupyter notebook внутри исследовательского репозитория с Python-кодом, вычислениями и графиками для воспроизводимого анализа.", expected: "code-source-notebooks" },
    { id: "project-kubernetes-iac", summary: "Kubernetes Deployment, Service и Ingress manifests, хранящиеся в infrastructure-as-code репозитории приложения.", expected: "code-infrastructure-kubernetes" },
    { id: "personal-kubernetes-ops", summary: "Мои эксплуатационные настройки домашнего Kubernetes-кластера с контекстами, namespace и локальными параметрами администрирования вне проекта.", expected: "mine-configs-kubernetes" },
    { id: "saved-official-doc-page", summary: "Одиночная сохранённая страница официальной документации PostgreSQL о настройке replication slots, открытая с сайта документации.", expected: "web-docs-official" },
    { id: "stackoverflow-question", summary: "Сохранённый вопрос Stack Overflow о deadlock в PostgreSQL вместе с несколькими ответами и принятым решением.", expected: "web-discussions-stackoverflow" },
    { id: "issue-export", summary: "Структурированный экспорт GitHub issue с состояниями, labels, авторами и полной историей комментариев команды.", expected: "comms-collaboration-issues" },
    { id: "saved-public-issue", summary: "Одиночная сохранённая веб-страница публичного GitHub issue с обсуждением бага и ответами разработчиков.", expected: "web-discussions-issues" },
    { id: "network-pcap", summary: "PCAPNG-захват сетевого трафика между reverse proxy и backend во время воспроизведения ошибки TLS.", expected: "data-network-pcap" },
    { id: "browser-har", summary: "HAR-выгрузка браузерной сессии с HTTP-запросами, ответами и timing для диагностики медленной загрузки страницы.", expected: "data-network-har" },
    { id: "process-core-dump", summary: "Core dump упавшего Linux-процесса с образом памяти для последующего анализа в gdb.", expected: "data-crash-core" },
    { id: "model-checkpoint", summary: "Файл checkpoint с весами обученной ML-модели и состоянием параметров для продолжения inference или fine-tuning.", expected: "data-ml-checkpoints" },
    { id: "container-image-archive", summary: "Экспортированный Docker image в tar-архиве со слоями и manifest для переноса образа на другой сервер.", expected: "archives-images-containers" },
    { id: "vm-disk-image", summary: "QCOW2-образ виртуальной машины с файловой системой и установленной операционной системой.", expected: "archives-images-vm" },
    { id: "terminal-screenshot-media", summary: "Скриншот терминала с сообщением об ошибке запуска OpenClaw Gateway и фрагментом stack trace.", expected: "mine-photos-screenshots" },
    { id: "architecture-diagram-image", summary: "PNG-диаграмма архитектуры сервиса с компонентами gateway, worker, database и стрелками потоков данных.", expected: "media-images-diagrams" },
    { id: "meeting-audio", summary: "Исходная аудиозапись рабочей встречи команды без текстовой расшифровки.", expected: "media-audio-meetings" },
    { id: "podcast-transcript", summary: "Текстовая расшифровка podcast-выпуска с репликами ведущего и гостя, разбитая по временным меткам.", expected: "comms-transcripts-podcasts" },
    { id: "security-scanner-output", summary: "Отчётный JSON-вывод vulnerability scanner с CVE, версиями пакетов, severity и найденными затронутыми компонентами.", expected: "security-scanner-results" },
    { id: "security-recon-working", summary: "Рабочий список обнаруженных доменов, IP, открытых сервисов и endpoints для последующей проверки поверхности атаки.", expected: "security-recon" },
    { id: "security-detection-rule", summary: "Sigma rule для обнаружения подозрительного запуска PowerShell с условиями по process creation events.", expected: "security-detection-rules" },
    { id: "security-forensics", summary: "Forensic timeline инцидента с файловыми артефактами, process events и результатами анализа дискового образа.", expected: "security-forensics" },
    { id: "personal-receipt", summary: "Электронный чек личной покупки оборудования с датой, магазином, суммой и перечнем товаров.", expected: "mine-records-receipts" },
    { id: "personal-lab-results", summary: "Личные результаты лабораторного анализа с показателями, единицами измерения и референсными значениями.", expected: "mine-records-labs" },
    { id: "travel-booking", summary: "Подтверждение бронирования гостиницы для личной поездки с датами заселения, номером брони и условиями отмены.", expected: "mine-records-bookings" },
    { id: "personal-resume", summary: "Актуальное резюме пользователя с опытом работы, навыками, образованием и контактными данными.", expected: "mine-records-resumes" },
  ]);
}

function main() {
  const taxonomyPath = resolve(process.argv[2] ?? "examples/resource-taxonomy.ru.yaml");
  const casesPath = resolve(process.argv[3] ?? "examples/routing-cases.ru.json");
  const sourceText = readFileSync(taxonomyPath, "utf8");
  const sourceSha = sha256(sourceText);
  if (sourceSha !== EXPECTED_REFINED_SHA256) {
    throw new Error(`expected refined taxonomy sha256 ${EXPECTED_REFINED_SHA256}, got ${sourceSha}; run the reviewed refinement step exactly once before this migration`);
  }

  const document = asRecord(parse(sourceText), "taxonomy document");
  document.categories = asRecord(document.categories, "taxonomy categories");
  if (findEntry(document.categories, SENTINEL_KEY)) {
    throw new Error("deep taxonomy migration appears to have already been applied; refusing a second application");
  }
  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  if (!Array.isArray(cases) || cases.length !== 110) {
    throw new Error(`expected 110 refined routing cases before deep migration, got ${Array.isArray(cases) ? cases.length : "non-array"}`);
  }

  deepenMine(document);
  deepenDocs(document);
  deepenCode(document);
  deepenWeb(document);
  deepenComms(document);
  deepenData(document);
  deepenArchives(document);
  addMedia(document);
  deepenSecurity(document);
  addCases(cases);

  const finalText = stringify(document, { lineWidth: 0 });
  const finalCases = `${JSON.stringify(cases, null, 2)}\n`;
  writeFileSync(taxonomyPath, finalText, "utf8");
  writeFileSync(casesPath, finalCases, "utf8");

  console.log("Applied deep Russian taxonomy architecture migration");
  console.log(`  taxonomy sha256: ${sourceSha} -> ${sha256(finalText)}`);
  console.log(`  routing cases: 110 -> ${cases.length}`);
  console.log(`  cases sha256: ${sha256(finalCases)}`);
}

main();
