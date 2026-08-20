export type ErrorCode = "BAD_REQUEST" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "UNAVAILABLE" | "INTERNAL";

export class AppError extends Error {
  public constructor(public readonly code: ErrorCode, message: string, public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503 | 500, public readonly issues?: Array<{ path: Array<string | number>; message: string }>) {
    super(message);
    this.name = "AppError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL", error instanceof Error ? error.message : "unexpected server error", 500);
}
