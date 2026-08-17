import { createApp } from "./app";

const port = Number(process.env.PORT ?? 4000);
const app = await createApp();

app.listen(port);

console.log(`Ampersand API listening on http://localhost:${port}`);
