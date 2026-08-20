import {
  attemptRequestSchema,
  validateAttemptForSpot,
  type AttemptRequest,
  type PublicSpot,
} from "@poker-trainer/contracts";

import type { PrivateSolutionPayload } from "./private-solution.js";

export function parseAttempt(payload: unknown): AttemptRequest {
  return attemptRequestSchema.parse(payload);
}

export function validateAttemptAgainstPublicSpot(
  spot: PublicSpot,
  payload: unknown,
): AttemptRequest {
  return validateAttemptForSpot(spot, payload);
}

export type PrivateSolutionReader = (spotVersionId: string) => Promise<PrivateSolutionPayload>;
