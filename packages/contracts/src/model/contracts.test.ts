import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { timestamp, uuid } from "../test-support";
import {
  ModelVersionStatusDto,
  PublishModelVersionParamsDto,
  PublishModelVersionResponseDto,
  isModelVersionTransitionAllowed,
  ModelRegistryResponseDto,
  ModelPublicationErrorDto,
} from "./index";

describe("model publication contracts", () => {
  it("accepts valid model statuses and publication data", () => {
    expect(Value.Check(ModelVersionStatusDto, "candidate")).toBe(true);
    expect(Value.Check(ModelVersionStatusDto, "deleted")).toBe(false);
    expect(
      Value.Check(PublishModelVersionParamsDto, { modelVersionId: uuid }),
    ).toBe(true);
    expect(
      Value.Check(PublishModelVersionResponseDto, {
        id: uuid,
        versionNumber: 1,
        status: "published",
        publishedAt: timestamp,
      }),
    ).toBe(true);
  });

  it("allows only the defined model transitions", () => {
    expect(isModelVersionTransitionAllowed("candidate", "published")).toBe(
      true,
    );
    expect(isModelVersionTransitionAllowed("candidate", "retired")).toBe(false);
    expect(isModelVersionTransitionAllowed("published", "retired")).toBe(true);
    expect(isModelVersionTransitionAllowed("retired", "published")).toBe(false);
  });

  it("accepts a model registry response", () => {
    expect(
      Value.Check(ModelRegistryResponseDto, {
        models: [
          {
            id: uuid,
            datasetDefinitionId: uuid,
            trainingJobId: uuid,
            versionNumber: 1,
            status: "candidate",
            parentVersionId: null,
            publishedAt: null,
            publishedBy: null,
            createdAt: timestamp,
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts structured publication errors", () => {
    expect(
      Value.Check(ModelPublicationErrorDto, {
        error: {
          code: "MODEL_VERSION_NOT_FOUND",
          message: "Model version was not found",
          currentStatus: null,
        },
      }),
    ).toBe(true);

    expect(
      Value.Check(ModelPublicationErrorDto, {
        error: {
          code: "INVALID_MODEL_TRANSITION",
          message: "Only candidate models can be published",
          currentStatus: null,
        },
      }),
    ).toBe(true);

    expect(
      Value.Check(ModelPublicationErrorDto, {
        error: {
          code: "UNKNOWN_ERROR",
          message: "Unknown error",
          currentStatus: null,
        },
      }),
    ).toBe(false);
  });
});
