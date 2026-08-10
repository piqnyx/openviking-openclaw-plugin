export type ResourceSemanticInputContext = {
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

const TEMPLATE_FIELD_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
export const RESOURCE_ROUTING_MAX_SUMMARY_CHARS = 4_000;

export function requireResourceSemanticSummary(summary: unknown): string {
  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error(
      "Automatic resource routing requires `summary`. Describe the resource's semantic content and purpose in one short sentence, then retry add_resource with that summary.",
    );
  }
  const normalized = summary.trim();
  if (Array.from(normalized).length > RESOURCE_ROUTING_MAX_SUMMARY_CHARS) {
    throw new Error(
      `Automatic resource routing summary must be at most ${RESOURCE_ROUTING_MAX_SUMMARY_CHARS} characters. Provide a concise semantic summary and retry add_resource.`,
    );
  }
  return normalized;
}

export function renderResourceSemanticInput(
  template: string,
  context: ResourceSemanticInputContext,
): string {
  const summary = requireResourceSemanticSummary(context.summary);
  const values: Record<string, string> = {
    summary,
    filename: context.filename?.trim() ?? "",
    extension: context.extension?.trim() ?? "",
    mimeType: context.mimeType?.trim() ?? "",
    sourceKind: context.sourceKind?.trim() ?? "",
    source: context.source?.trim() ?? "",
    reason: context.reason?.trim() ?? "",
    instruction: context.instruction?.trim() ?? "",
    agentId: context.agentId?.trim() ?? "",
  };

  const rendered = template.replace(TEMPLATE_FIELD_RE, (_match, field: string) => values[field] ?? "").trim();
  if (!rendered) {
    throw new Error("resource routing semantic input rendered to an empty string");
  }
  return rendered;
}
