export class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(typeof message === "string" && message ? message : "服务暂时不可用，请稍后再试");
    this.name = "AppError";
    this.status = Number.isInteger(Number(status)) ? Number(status) : 500;
    this.code = typeof code === "string" && code ? code : "internal_error";
    this.expose = options.expose !== undefined ? Boolean(options.expose) : this.status < 500;

    if (options.details !== undefined) {
      this.details = options.details;
    }

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isAppError(error) {
  return error instanceof AppError
    || (
      error
      && typeof error === "object"
      && Number.isInteger(Number(error.status))
      && typeof error.code === "string"
    );
}

export function errorResponsePayload(error) {
  const appError = isAppError(error) ? error : null;
  const status = appError && Number.isInteger(Number(appError.status))
    ? Number(appError.status)
    : 500;
  const code = appError && typeof appError.code === "string" && appError.code
    ? appError.code
    : "internal_error";

  const shouldExposeMessage = Boolean(
    appError
      && typeof appError.message === "string"
      && appError.message
      && (appError.expose === true || (appError.expose !== false && status < 500)),
  );

  const payload = {
    message: shouldExposeMessage ? appError.message : "服务暂时不可用，请稍后再试",
    code,
  };

  if (appError && status < 500 && appError.details !== undefined) {
    payload.details = appError.details;
  }

  return {
    status,
    payload,
  };
}
