import type { z } from "zod";
import { apiErrorCodeSchema } from "@poker-trainer/contracts";

export type ErrorCode = z.infer<typeof apiErrorCodeSchema>;

export class AppError extends Error {
  public constructor(public readonly code: ErrorCode, message: string, public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503 | 500, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL", "request failed", 500);
}
