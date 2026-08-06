import { Type, type Static } from "@sinclair/typebox";

export const ToolPropertyTypeDto = Type.Union([
  Type.Literal("number"),
  Type.Literal("integer"),
  Type.Literal("boolean"),
  Type.Literal("string"),
]);

export type ToolPropertyType = Static<typeof ToolPropertyTypeDto>;

export const ToolInputPropertyDto = Type.Object(
  {
    type: ToolPropertyTypeDto,
    description: Type.String({ minLength: 1 }),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
    enum: Type.Optional(
      Type.Array(Type.Union([Type.String(), Type.Number()]), {
        minItems: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export type ToolInputProperty = Static<typeof ToolInputPropertyDto>;

export const ToolInputSchemaDto = Type.Object(
  {
    type: Type.Literal("object"),
    properties: Type.Record(Type.String(), ToolInputPropertyDto),
    required: Type.Array(Type.String(), { uniqueItems: true }),
    additionalProperties: Type.Literal(false),
  },
  { additionalProperties: false },
);

export type ToolInputSchema = Static<typeof ToolInputSchemaDto>;

export const ToolOutputSchemaDto = Type.Object(
  {
    type: Type.Literal("object"),
    properties: Type.Object(
      {
        outcome: Type.Object(
          { enum: Type.Tuple([Type.Literal("prediction"), Type.Literal("rejected")]) },
          { additionalProperties: false },
        ),
        prediction: Type.Object(
          { type: Type.Tuple([Type.Literal("number"), Type.Literal("null")]) },
          { additionalProperties: false },
        ),
        uncertainty: Type.Object(
          { type: Type.Tuple([Type.Literal("number"), Type.Literal("null")]) },
          { additionalProperties: false },
        ),
        modelVersion: Type.Object(
          { type: Type.Literal("integer") },
          { additionalProperties: false },
        ),
        warnings: Type.Object(
          {
            type: Type.Literal("array"),
            items: Type.Object(
              { type: Type.Literal("string") },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
        rejection: Type.Object(
          { type: Type.Tuple([Type.Literal("object"), Type.Literal("null")]) },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    required: Type.Tuple([
      Type.Literal("outcome"),
      Type.Literal("prediction"),
      Type.Literal("uncertainty"),
      Type.Literal("modelVersion"),
      Type.Literal("warnings"),
      Type.Literal("rejection"),
    ]),
    additionalProperties: Type.Literal(false),
  },
  { additionalProperties: false },
);

export type ToolOutputSchema = Static<typeof ToolOutputSchemaDto>;

export const GeneratedToolDefinitionDto = Type.Object(
  {
    modelVersionId: Type.String({ format: "uuid" }),
    toolName: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    generatorVersion: Type.String({ minLength: 1 }),
    inputSchema: ToolInputSchemaDto,
    outputSchema: ToolOutputSchemaDto,
  },
  { additionalProperties: false },
);

export type GeneratedToolDefinition = Static<
  typeof GeneratedToolDefinitionDto
>;
