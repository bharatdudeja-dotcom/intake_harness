import { NextResponse } from "next/server";

/**
 * A structured error body — {error, code} instead of a bare string — so a
 * caller (or our own client-side fetch handlers) can branch on `code`
 * ("the run doesn't exist" vs. "you're not allowed to do this") without
 * parsing `error`'s English text. Ported from a pattern in a sibling
 * harness that already does this consistently across every route.
 */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
  details?: Record<string, unknown>;
}

/** The JSON error response every API route in this app returns on failure. */
export function apiError(
  message: string,
  code: ApiErrorCode,
  status: number,
  details?: Record<string, unknown>,
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: message, code, ...(details ? { details } : {}) }, { status });
}
