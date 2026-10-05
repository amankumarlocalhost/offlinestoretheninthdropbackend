// Every expected failure is an AppError so the API always answers
// { message, code } with the right HTTP status.
export class AppError extends Error {
  constructor(message, code = "BAD_REQUEST", status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError(msg, "BAD_REQUEST", 400, details);
export const unauthorized = (msg = "Please sign in.") => new AppError(msg, "UNAUTHORIZED", 401);
export const forbidden = (msg = "You do not have permission to do this.") => new AppError(msg, "FORBIDDEN", 403);
export const notFound = (msg = "Not found.") => new AppError(msg, "NOT_FOUND", 404);
export const conflict = (msg, code = "CONFLICT") => new AppError(msg, code, 409);
