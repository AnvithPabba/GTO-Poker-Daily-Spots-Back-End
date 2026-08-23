import {
  apiErrorSchema,
  attemptHistoryResponseSchema,
  attemptResourceSchema,
  createAttemptRequestSchema,
  createAttemptResponseSchema,
  dailyGameRangeResponseSchema,
  dailyGameSchema,
  publicSpotSchema,
  statsResponseSchema,
} from "@poker-trainer/contracts";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

type Operation = {
  method: "get" | "post";
  path: string;
  operationId: string;
  summary: string;
  responseSchema: ZodTypeAny;
  responseName: string;
  requestSchema?: ZodTypeAny;
  requestName?: string;
  query?: Array<{ name: string; required?: boolean; description?: string }>;
};

/** Runtime schemas and API documentation share this public operation registry. */
export const PUBLIC_API_OPERATIONS: readonly Operation[] = [
  { method: "get", path: "/api/v1/daily-games/today", operationId: "getTodayDailyGame", summary: "Get today's Pacific daily game", responseSchema: dailyGameSchema, responseName: "DailyGame" },
  { method: "get", path: "/api/v1/daily-games/{date}", operationId: "getDailyGame", summary: "Get one historical daily game", responseSchema: dailyGameSchema, responseName: "DailyGame" },
  { method: "get", path: "/api/v1/daily-games", operationId: "listDailyGames", summary: "List archive calendar summaries", responseSchema: dailyGameRangeResponseSchema, responseName: "DailyGameRangeResponse", query: [{ name: "from", required: true }, { name: "to", required: true }] },
  { method: "get", path: "/api/v1/spots/{spotId}", operationId: "getSpot", summary: "Get one public challenge", responseSchema: publicSpotSchema, responseName: "PublicSpot" },
  { method: "post", path: "/api/v1/spots/{spotId}/attempts", operationId: "createAttempt", summary: "Score and persist an attempt", requestSchema: createAttemptRequestSchema, requestName: "CreateAttemptRequest", responseSchema: createAttemptResponseSchema, responseName: "CreateAttemptResponse" },
  { method: "get", path: "/api/v1/attempts/{attemptId}", operationId: "getAttempt", summary: "Get an ownership-checked attempt result", responseSchema: attemptResourceSchema, responseName: "AttemptResource" },
  { method: "get", path: "/api/v1/users/me/stats", operationId: "getMyStats", summary: "Get statistics for the current principal", responseSchema: statsResponseSchema, responseName: "StatsResponse" },
  { method: "get", path: "/api/v1/users/me/attempts", operationId: "getMyAttempts", summary: "Get paginated attempt history", responseSchema: attemptHistoryResponseSchema, responseName: "AttemptHistoryResponse", query: [{ name: "limit" }, { name: "cursor" }] },
] as const;

const CONTRACT_SCHEMAS: Record<string, ZodTypeAny> = {
  ApiError: apiErrorSchema,
  AttemptHistoryResponse: attemptHistoryResponseSchema,
  AttemptResource: attemptResourceSchema,
  CreateAttemptRequest: createAttemptRequestSchema,
  CreateAttemptResponse: createAttemptResponseSchema,
  DailyGame: dailyGameSchema,
  DailyGameRangeResponse: dailyGameRangeResponseSchema,
  PublicSpot: publicSpotSchema,
  StatsResponse: statsResponseSchema,
};

function schemaReference(name: string) { return { $ref: `#/components/schemas/${name}` }; }
function pathParameters(path: string) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }));
}

export function createOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemaNames = new Set<string>(["ApiError"]);
  for (const operation of PUBLIC_API_OPERATIONS) {
    schemaNames.add(operation.responseName);
    if (operation.requestName) schemaNames.add(operation.requestName);
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method] = {
      operationId: operation.operationId,
      summary: operation.summary,
      parameters: [
        ...pathParameters(operation.path),
        ...(operation.query ?? []).map((query) => ({ name: query.name, in: "query", required: query.required ?? false, schema: { type: "string" }, ...(query.description ? { description: query.description } : {}) })),
        ...(operation.method === "post" ? [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 16, maxLength: 256 } }] : []),
      ],
      ...(operation.requestName ? { requestBody: { required: true, content: { "application/json": { schema: schemaReference(operation.requestName) } } } } : {}),
      responses: {
        [operation.method === "post" ? "201" : "200"]: { description: operation.method === "post" ? "Created" : "Success", content: { "application/json": { schema: schemaReference(operation.responseName) } } },
        default: { description: "Error", content: { "application/json": { schema: schemaReference("ApiError") } } },
      },
    };
  }
  const schemas = Object.fromEntries([...schemaNames].map((name) => {
    const runtimeSchema = CONTRACT_SCHEMAS[name];
    if (!runtimeSchema) throw new Error(`missing runtime schema for ${name}`);
    return [name, { ...(zodToJsonSchema(runtimeSchema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>), "x-zod-source": `@poker-trainer/contracts:${name}` }];
  }));
  return { openapi: "3.1.0", info: { title: "Poker Daily Trainer API", version: "0.3.0" }, servers: [{ url: "/" }], paths, components: { schemas } } as const;
}
