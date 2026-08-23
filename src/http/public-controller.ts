import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import type { IdentityProvider } from "../ports.js";
import type { PublicApplicationService } from "../application/public-api.js";
import { AppError } from "../errors.js";
import { pacificDate } from "../publication.js";
import { createOpenApiDocument } from "../openapi.js";
import { resolveVisitor } from "./visitor.js";

export type PublicUseCases = Pick<PublicApplicationService,
  "getDailyGame" | "getDailyGameRange" | "getSpot" | "createAttempt" | "getAttempt" | "getStats" | "getAttemptHistory"
>;

export type PublicControllerOptions = {
  application: PublicUseCases;
  prisma: PrismaClient;
  guestCookieHashSecret: string;
  guestCookieName: string;
  secureCookies: boolean;
  identityProvider?: IdentityProvider;
};

function etag(value: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(value)).digest("hex")}"`;
}

function parameter(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string") throw new AppError("BAD_REQUEST", `missing ${name}`, 400);
  return value;
}

function isoDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError("BAD_REQUEST", `${name} must be YYYY-MM-DD`, 400);
  return value;
}

export class PublicController {
  public constructor(private readonly options: PublicControllerOptions) {}

  private visitor(request: Request, response: Response) {
    return resolveVisitor(request, response, this.options);
  }

  public openApi = async (_request: Request, response: Response): Promise<void> => {
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.json(createOpenApiDocument());
  };

  public today = async (request: Request, response: Response): Promise<void> => {
    const visitor = await this.visitor(request, response);
    const data = await this.options.application.getDailyGame(pacificDate(), visitor, true);
    const tag = etag(data);
    response.setHeader("ETag", tag);
    response.setHeader("Cache-Control", "private, no-cache");
    response.setHeader("Vary", "Cookie, Authorization");
    if (request.header("if-none-match") === tag) { response.status(304).end(); return; }
    response.json(data);
  };

  public dailyRange = async (request: Request, response: Response): Promise<void> => {
    const visitor = await this.visitor(request, response);
    const from = isoDate(request.query.from, "from");
    const to = isoDate(request.query.to, "to");
    response.setHeader("Cache-Control", "private, no-cache");
    response.json(await this.options.application.getDailyGameRange(from, to, visitor));
  };

  public dailyByDate = async (request: Request, response: Response): Promise<void> => {
    const date = isoDate(parameter(request, "date"), "date");
    const visitor = await this.visitor(request, response);
    response.setHeader("Cache-Control", "private, no-cache");
    response.json(await this.options.application.getDailyGame(date, visitor, false));
  };

  public spot = async (request: Request, response: Response): Promise<void> => {
    const data = await this.options.application.getSpot(parameter(request, "spotId"));
    const tag = etag(data);
    response.setHeader("ETag", tag);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (request.header("if-none-match") === tag) { response.status(304).end(); return; }
    response.json(data);
  };

  public createAttempt = async (request: Request, response: Response): Promise<void> => {
    const visitor = await this.visitor(request, response);
    const result = await this.options.application.createAttempt(parameter(request, "spotId"), request.body, request.header("idempotency-key") ?? "", visitor);
    response.status(201).setHeader("Location", `/api/v1/attempts/${result.attemptId}`).json(result);
  };

  public attempt = async (request: Request, response: Response): Promise<void> => {
    const visitor = await this.visitor(request, response);
    response.setHeader("Cache-Control", "private, no-store");
    response.json(await this.options.application.getAttempt(parameter(request, "attemptId"), visitor));
  };

  public stats = async (request: Request, response: Response): Promise<void> => {
    const visitor = await this.visitor(request, response);
    response.setHeader("Cache-Control", "private, no-store");
    response.json(await this.options.application.getStats(visitor));
  };

  public attemptHistory = async (request: Request, response: Response): Promise<void> => {
    const visitor = await this.visitor(request, response);
    const parsed = Number(request.query.limit ?? 20);
    const limit = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 100) : 20;
    response.setHeader("Cache-Control", "private, no-store");
    response.json(await this.options.application.getAttemptHistory(visitor, limit, typeof request.query.cursor === "string" ? request.query.cursor : undefined));
  };
}
