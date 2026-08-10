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

  const rendered = template.replace(PLACEHOLDER_RE, (_match, rawField: string) => {
    const field = rawField as keyof ResourceRoutingSemanticContext;
    if (!ALLOWED_FIELDS.has(field)) {
      throw new Error(`resource routing semantic input template contains unknown field ${JSON.stringify(rawField)}`);
    }
    const value = context[field];
    return typeof value === "string" ? value.trim() : "";
  }).trim();

  if (!rendered) {
    throw new Error("resource routing semantic input rendered to an empty string");
  }
  return rendered;
}
