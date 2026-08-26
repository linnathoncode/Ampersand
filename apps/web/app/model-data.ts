import type {
  ModelRegistryResponse,
  ModelVersionStatus,
  ModelVersionSummary,
  PublishModelVersionResponse,
  RetireModelVersionResponse,
} from "@ampersand/contracts";

import { createTenantHeaders, fetchWithAuthRedirect, nucleusUrl } from "./auth/client";

export type ModelDefinition = {
  slug: string;
  name: string;
  target: string;
  availableTools: number;
  latestStatus: ModelVersionStatus;
  lastTrainedAt: string;
};

export type RegistryModelVersion = ModelVersionSummary & {
  toolAvailability: "not-generated" | "available" | "unavailable";
};

type DiscoverableTool = { modelVersionId: string };

export function modelSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function modelName(model: ModelVersionSummary): string {
  return model.datasetName ?? `Model ${model.id.slice(0, 8)}`;
}

export function getModelDefinitions(
  models: RegistryModelVersion[],
): ModelDefinition[] {
  const definitions = new Map<string, ModelDefinition>();

  for (const model of models) {
    const name = modelName(model);
    const target = model.targetColumn ?? "Prediction";
    const slug = modelSlug(name);

    if (!definitions.has(slug)) {
      definitions.set(slug, {
        slug,
        name,
        target,
        availableTools: models.filter(
          (candidate) =>
            modelSlug(modelName(candidate)) === slug &&
            candidate.toolAvailability === "available",
        ).length,
        latestStatus: model.status,
        lastTrainedAt: model.createdAt,
      });
    }
  }

  return [...definitions.values()];
}

export async function fetchModelRegistry(
  tenant: string,
): Promise<RegistryModelVersion[]> {
  const headers = createTenantHeaders(tenant);
  const [modelsResponse, toolsResponse] = await Promise.all([
    fetchWithAuthRedirect(`${nucleusUrl}/model-versions`, {
      credentials: "include",
      headers,
      cache: "no-store",
    }),
    fetchWithAuthRedirect(`${nucleusUrl}/tools`, {
      credentials: "include",
      headers,
      cache: "no-store",
    }),
  ]);

  if (!modelsResponse.ok) {
    throw new Error(await getApiError(modelsResponse, "Could not load models"));
  }

  const registry = (await modelsResponse.json()) as ModelRegistryResponse;
  const discoverableTools = toolsResponse.ok
    ? ((await toolsResponse.json()) as DiscoverableTool[])
    : [];
  const toolModelIds = new Set(
    discoverableTools.map((tool) => tool.modelVersionId),
  );

  return registry.models.map((model) => ({
    ...model,
    toolAvailability:
      model.status === "retired"
        ? "unavailable"
        : toolModelIds.has(model.id)
          ? "available"
          : "not-generated",
  }));
}

export async function updateModelVersionStatus(
  tenant: string,
  modelVersionId: string,
  action: "publish" | "retire",
): Promise<PublishModelVersionResponse | RetireModelVersionResponse> {
  const response = await fetchWithAuthRedirect(
    `${nucleusUrl}/model-versions/${modelVersionId}/${action}`,
    {
      method: "POST",
      credentials: "include",
      headers: createTenantHeaders(tenant),
    },
  );

  if (!response.ok) {
    throw new Error(await getApiError(response, "Model update failed"));
  }

  return response.json();
}

async function getApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function formatDate(value: string | null): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
