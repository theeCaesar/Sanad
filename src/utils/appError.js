class AppError extends Error {
  constructor(message, statusCode, opts = {}) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;

    this.code = opts.code || null;
    this.details = opts.details || null;
    this.retryable = opts.retryable ?? false;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
