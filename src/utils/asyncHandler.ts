import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 doesn't catch rejected promises from async route handlers — an
 * unawaited throw would otherwise hang the request instead of surfacing as a
 * 500. Wrap every async handler with this so errors reach the error middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
