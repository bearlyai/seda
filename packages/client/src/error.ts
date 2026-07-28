import type { ErrorBody, ErrorCode } from "./types.js";

export class SedaError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly status?: number;

  constructor(
    body: ErrorBody,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(body.message, { cause: options.cause });
    this.name = "SedaError";
    this.code = body.code;
    this.recoverable = body.recoverable;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}
export function clientError(
  message: string,
  cause?: unknown,
): SedaError {
  return new SedaError(
    {
      code: "runtime_failed",
      message,
      recoverable: false,
    },
    { cause },
  );
}
