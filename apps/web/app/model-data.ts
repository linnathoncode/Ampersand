import type { ModelVersionStatus, ModelVersionSummary } from "@ampersand/contracts";

export type ModelDefinition = {
  slug: string;
  name: string;
  target: string;
  availableTools: number;
  latestStatus: ModelVersionStatus;
  lastTrainedAt: string;
};

export const modelDefinitions: ModelDefinition[] = [
  { slug: "energy-usage-predictor", name: "Energy usage predictor", target: "energy_usage", availableTools: 1, latestStatus: "candidate", lastTrainedAt: "2026-08-20T08:42:00.000Z" },
  { slug: "demand-forecast", name: "Demand forecast", target: "weekly_demand", availableTools: 1, latestStatus: "published", lastTrainedAt: "2026-08-18T13:20:00.000Z" },
  { slug: "maintenance-risk", name: "Maintenance risk", target: "failure_risk", availableTools: 0, latestStatus: "candidate", lastTrainedAt: "2026-08-16T09:05:00.000Z" },
];

export type RegistryModelVersion = ModelVersionSummary & {
  toolAvailability: "not-generated" | "available" | "unavailable";
};

export const sampleModelVersions: RegistryModelVersion[] = [
  { id: "c90cf8e2-baa5-4e54-8f1a-2f3fb82ea808", datasetDefinitionId: "8dad1b60-c251-4b19-8c7d-0f70b0367ef0", trainingJobId: "fe561ed9-9eca-450c-a9b5-b3ed8c184042", versionNumber: 3, status: "candidate", toolAvailability: "not-generated", parentVersionId: "7508315f-6f4c-43ce-a5be-8268f5789369", publishedBy: null, publishedAt: null, retiredBy: null, retiredAt: null, createdAt: "2026-08-20T08:42:00.000Z" },
  { id: "7508315f-6f4c-43ce-a5be-8268f5789369", datasetDefinitionId: "8dad1b60-c251-4b19-8c7d-0f70b0367ef0", trainingJobId: "730e1566-aea5-4238-aaf8-c8bd5b92f243", versionNumber: 2, status: "published", toolAvailability: "available", parentVersionId: "2cf1a2a7-8c78-4105-993a-3f502fb59785", publishedBy: "0a5c53d3-77f1-436a-acf8-875af23ea54f", publishedAt: "2026-08-12T10:15:00.000Z", retiredBy: null, retiredAt: null, createdAt: "2026-08-12T09:58:00.000Z" },
  { id: "2cf1a2a7-8c78-4105-993a-3f502fb59785", datasetDefinitionId: "8dad1b60-c251-4b19-8c7d-0f70b0367ef0", trainingJobId: "a8e50fc4-868b-4894-9859-2ea8c221555f", versionNumber: 1, status: "retired", toolAvailability: "unavailable", parentVersionId: null, publishedBy: "0a5c53d3-77f1-436a-acf8-875af23ea54f", publishedAt: "2026-08-04T11:20:00.000Z", retiredBy: "0a5c53d3-77f1-436a-acf8-875af23ea54f", retiredAt: "2026-08-12T10:15:00.000Z", createdAt: "2026-08-04T10:52:00.000Z" },
];

export function formatDate(value: string | null): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}
