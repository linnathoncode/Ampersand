import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { NucleusElysiaPlugin } from "nucleus-core-ts";

import { chatRoutes } from "./chat/routes";
import { datasetRoutes } from "./dataset/routes";
import { internalRoutes } from "./internal/routes";
import { modelRoutes } from "./model/routes";
import { predictionRoutes } from "./prediction/routes";
import { toolDefinitionRoutes } from "./tool-definitions/routes";
import { trainingRoutes } from "./training/routes";

export async function createApp() {
  const nucleus = await NucleusElysiaPlugin({
    options: "./src/config.json",
    schema: "./src/drizzle/schema.ts",
    relations: "./src/drizzle/relations.ts",
    swagger: { path: "/docs" },
  });

  return new Elysia()
    .use(
      cors({
        origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
        credentials: true,
      }),
    )
    .use(nucleus)
    .use(modelRoutes)
    .use(chatRoutes)
    .use(datasetRoutes)
    .use(toolDefinitionRoutes)
    .use(predictionRoutes)
    .use(trainingRoutes)
    .use(internalRoutes);
}
