import { basename, extname } from "node:path";

import type { AddResourceInput } from "../client.js";
import type { ResourceRoutingDecision } from "./decision.js";
import type { ResourceRoutingManager } from "./manager.js";

export type AddResourceRoutingMode =
  | "explicit-to"
  | "explicit-parent"
  | "explicit-category"
  | "automatic"
  | "legacy-root";

export type AddResourceRoutingDetails = {
  mode: AddResourceRoutingMode;
  categoryKey?: string;
  parentUri?: string;
  fallback?: boolean;
  fallbackReason?: string;
  embeddingTop?: ResourceRoutingDecision["embeddingTop"];
  rerankerUsed?: boolean;
  rerankerScores?: ResourceRoutingDecision["rerankerScores"];
};

export type AddResourceRoutingPlan = {
  input: AddResourceInput;
  details: AddResourceRoutingDetails;
};

export class AddResourceRoutingError extends Error {
  constructor(
    readonly code:
      | "summary_required"
      | "routing_disabled"
      | "invalid_category"
      | "routing_infrastructure_error",
    message: string,
  ) {
    super(message);
    this.name = "AddResourceRoutingError";
  }
}

export type AddResourceRoutingParams = {
  source: string;
  to?: string;
  parent?: string;
  category?: string;
  summary?: string;
  createParent?: boolean;
  reason?: string;
  instruction?: string;
  wait?: boolean;
  timeout?: number;
};

export type AddResourceRoutingManager = Pick<
  ResourceRoutingManager,
  "isEnabled" | "resolveCategory" | "routeResource"
>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function classifySourceKind(source: string): string {
  const lower = source.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return "web";
  }
  if (lower.startsWith("git@") || lower.startsWith("ssh://") || lower.startsWith("git://")) {
    return "git";
  }
  return "local-file-or-directory";
}

function sourceFilename(source: string): string {
  const sourceKind = classifySourceKind(source);
  if (sourceKind === "web") {
    try {
      const parsed = new URL(source);
      return basename(parsed.pathname) || "";
    } catch {
      return "";
    }
  }
  if (sourceKind === "git") {
    const withoutTrailing = source.replace(/\/+$/, "");
    return basename(withoutTrailing).replace(/\.git$/i, "");
  }
  return basename(source.replace(/\/+$/, ""));
}

function baseInput(params: AddResourceRoutingParams): AddResourceInput {
  return {
    pathOrUrl: params.source,
    reason: params.reason,
    instruction: params.instruction,
    wait: params.wait,
    timeout: params.timeout,
  };
}

function automaticError(error: unknown): AddResourceRoutingError {
  if (error instanceof AddResourceRoutingError) {
    return error;
  }
  return new AddResourceRoutingError(
    "routing_infrastructure_error",
    `Automatic resource routing failed; the resource was not imported. ${error instanceof Error ? error.message : String(error)}`,
  );
}

export async function planAddResourceRouting(options: {
  agentId: string;
  params: AddResourceRoutingParams;
  manager?: AddResourceRoutingManager;
}): Promise<AddResourceRoutingPlan> {
  const source = nonEmpty(options.params.source);
  if (!source) {
    throw new Error("add_resource source is required");
  }

  const to = nonEmpty(options.params.to);
  if (to) {
    return {
      input: { ...baseInput({ ...options.params, source }), to },
      details: { mode: "explicit-to" },
    };
  }

  const parent = nonEmpty(options.params.parent);
  if (parent) {
    return {
      input: {
        ...baseInput({ ...options.params, source }),
        parent,
        createParent: options.params.createParent,
      },
      details: { mode: "explicit-parent", parentUri: parent },
    };
  }

  const category = nonEmpty(options.params.category);
  if (category) {
    if (!options.manager?.isEnabled()) {
      throw new AddResourceRoutingError(
        "routing_disabled",
        "Resource category routing is disabled. Use an explicit `to` or `parent`, or enable OpenViking resourceRouting.",
      );
    }
    try {
      const resolved = await options.manager.resolveCategory(options.agentId, category);
      return {
        input: {
          ...baseInput({ ...options.params, source }),
          parent: resolved.categoryUri,
          createParent: true,
        },
        details: {
          mode: "explicit-category",
          categoryKey: resolved.categoryKey,
          parentUri: resolved.categoryUri,
        },
      };
    } catch (error) {
      throw new AddResourceRoutingError(
        "invalid_category",
        `Resource category ${JSON.stringify(category)} is not available for agent ${JSON.stringify(options.agentId)}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!options.manager?.isEnabled()) {
    return {
      input: baseInput({ ...options.params, source }),
      details: { mode: "legacy-root" },
    };
  }

  const summary = nonEmpty(options.params.summary);
  if (!summary) {
    throw new AddResourceRoutingError(
      "summary_required",
      "Automatic resource routing requires `summary`. Describe the resource's semantic content and purpose in one short sentence, then retry add_resource with that summary. Do not describe only its filename, path, MIME type, or storage location.",
    );
  }

  const filename = sourceFilename(source);
  try {
    const decision = await options.manager.routeResource(options.agentId, {
      summary,
      filename,
      extension: filename ? extname(filename).replace(/^\./, "") : "",
      sourceKind: classifySourceKind(source),
      source,
      reason: options.params.reason,
      instruction: options.params.instruction,
    });
    return {
      input: {
        ...baseInput({ ...options.params, source }),
        parent: decision.categoryUri,
        createParent: true,
      },
      details: {
        mode: "automatic",
        categoryKey: decision.categoryKey,
        parentUri: decision.categoryUri,
        fallback: decision.fallback,
        fallbackReason: decision.fallbackReason,
        embeddingTop: decision.embeddingTop,
        rerankerUsed: decision.rerankerUsed,
        rerankerScores: decision.rerankerScores,
      },
    };
  } catch (error) {
    throw automaticError(error);
  }
}
