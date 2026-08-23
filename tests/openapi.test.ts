import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOpenApiDocument, PUBLIC_API_OPERATIONS } from "../src/openapi.js";

describe("OpenAPI documentation", () => {
  it("is generated deterministically from the runtime Zod contract registry", () => {
    // Arrange
    const checkedIn = JSON.parse(readFileSync(new URL("../docs/openapi-v1.json", import.meta.url), "utf8"));

    // Act
    const generated = createOpenApiDocument();

    // Assert
    expect(checkedIn).toEqual(generated);
    expect(generated.info.version).toBe("0.3.1");
  });

  it("documents every public application route exactly once", () => {
    // Arrange
    const routeSource = readFileSync(new URL("../src/http/public-router.ts", import.meta.url), "utf8");
    const routePattern = /router\.(get|post)\("([^"?]+)"/g;
    const implemented = [...routeSource.matchAll(routePattern)]
      .map((match) => `${match[1]} /api/v1${match[2]}`)
      .filter((route) => !route.endsWith("/openapi.json"))
      .sort();

    // Act
    const documented = PUBLIC_API_OPERATIONS.map((operation) => `${operation.method} ${operation.path.replace(/\{([^}]+)\}/g, ":$1")}`).sort();

    // Assert
    expect(documented).toEqual(implemented);
  });
});
