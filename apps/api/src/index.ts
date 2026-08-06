import { Elysia } from "elysia";
import { NucleusElysiaPlugin } from "nucleus-core-ts";
import { modelRoutes } from "./model/routes";
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
  .listen(port);

console.log(`Ampersand API listening on http://localhost:${port}`);
