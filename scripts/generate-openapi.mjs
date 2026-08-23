import { writeFile } from "node:fs/promises";
import { createOpenApiDocument } from "../dist/openapi.js";

const target = new URL("../docs/openapi-v1.json", import.meta.url);
await writeFile(target, `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`, "utf8");
console.log(`wrote ${target.pathname}`);
