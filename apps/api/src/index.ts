import { Elysia } from "elysia";
import { NucleusElysiaPlugin } from "nucleus-core-ts";
import { datasetRoutes } from "./dataset/routes";
import { modelRoutes } from "./model/routes";
import { predictionRoutes } from "./prediction/routes";
import { toolDefinitionRoutes } from "./tool-definitions/routes";
import { trainingRoutes } from "./training/routes";
const port = Number(process.env.PORT ?? 4000);

new Elysia()
  .use(
    await NucleusElysiaPlugin({
      options: "./src/config.json",
      schema: "./src/drizzle/schema.ts",
      relations: "./src/drizzle/relations.ts",
      swagger: { path: "/docs" },
    }),
  )
  .use(modelRoutes)
  .use(datasetRoutes)
  .use(toolDefinitionRoutes)
  .use(predictionRoutes)
  .use(trainingRoutes)
  .listen(port);

console.log(`Ampersand API listening on http://localhost:${port}`);
