export type ResourceRoutingSemanticContext = {
  summary: string;
  filename?: string;
  extension?: string;
  mimeType?: string;
  sourceKind?: string;
  source?: string;
  reason?: string;
  instruction?: string;
  agentId?: string;
};

const PLACEHOLDER_RE = /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;
const ALLOWED_FIELDS = new Set<keyof ResourceRoutingSemanticContext>([
  "summary",
  "filename",
  "extension",
  "mimeType",
  "sourceKind",
  "source",
  "reason",
  "instruction",
  "agentId",
]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  zip: "application/zip",
};

export function inferResourceRoutingMimeType(extension: string | undefined): string | undefined {
  if (typeof extension !== "string") {
    return undefined;
  }
  const normalized = extension.trim().replace(/^\./, "").toLowerCase();
  return normalized ? MIME_BY_EXTENSION[normalized] : undefined;
}

export function renderResourceRoutingSemanticInput(
  template: string,
  context: ResourceRoutingSemanticContext,
): string {
  if (typeof context.summary !== "string" || !context.summary.trim()) {
    throw new Error(
      "Automatic resource routing requires `summary`. Provide one short sentence describing the resource's semantic content and purpose, then retry add_resource.",
    );
  }
  if (typeof template !== "string" || !template.trim()) {
    throw new Error("resource routing semantic input template must be a non-empty string");
  }

  const normalizedContext: ResourceRoutingSemanticContext = {
    ...context,
    mimeType: context.mimeType ?? inferResourceRoutingMimeType(context.extension),
  };

  const rendered = template.replace(PLACEHOLDER_RE, (_match, rawField: string) => {
    const field = rawField as keyof ResourceRoutingSemanticContext;
    if (!ALLOWED_FIELDS.has(field)) {
      throw new Error(`resource routing semantic input template contains unknown field ${JSON.stringify(rawField)}`);
    }
    const value = normalizedContext[field];
    return typeof value === "string" ? value.trim() : "";
  }).trim();

  if (!rendered) {
    throw new Error("resource routing semantic input rendered to an empty string");
  }
  return rendered;
}
