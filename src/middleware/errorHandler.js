const AppError = require('../utils/appError');
const logger = require('../utils/logger');
const { t, getLocale } = require('../utils/i18n');

const handlePgError = (err) => {
  switch (err.code) {
    case '23505':
      if (String(err.detail || '').includes('mutation_id')) {
        return new AppError('Already synced.', 200, { code: 'DUPLICATE', retryable: false });
      }
      return new AppError('That already exists.', 409, { code: 'DUPLICATE', retryable: false });

    case '23503':
      return new AppError('Referenced record does not exist.', 400, {
        code: 'BAD_REFERENCE', retryable: false,
      });

    case '23514':
      if (String(err.constraint || '').includes('qty_nonneg')) {
        return new AppError('Not enough stock.', 409, {
          code: 'INSUFFICIENT_STOCK', retryable: false,
        });
      }
      return new AppError('That change is not allowed.', 400, {
        code: 'CONSTRAINT_VIOLATION', retryable: false,
      });

    case '40001':
    case '40P01':
      return new AppError('Busy — please retry.', 503, {
        code: 'RETRY', retryable: true,
      });

    case '57014':
      return new AppError('That took too long.', 504, { code: 'TIMEOUT', retryable: true });

    default:
      return null;
  }
};

module.exports = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof AppError)) {
    const pg = handlePgError(err);
    if (pg) error = pg;
  }

  const statusCode = error.statusCode || 500;
  const isOperational = error.isOperational === true;

  if (statusCode >= 500 || !isOperational) {
    logger.error(
      {
        err: { message: err.message, stack: err.stack, code: err.code },
        trace_id: req.traceId,
        route: req.originalUrl,
        method: req.method,
        user_id: req.ctx?.userId,
        device_id: req.ctx?.deviceId,
      },
      'unhandled error'
    );
  } else {
    logger.warn(
      { code: error.code, status: statusCode, route: req.originalUrl, trace_id: req.traceId },
      error.message
    );
  }

  const locale = getLocale(req);
  const body = {
    status: statusCode >= 500 ? 'error' : 'fail',
    message: error.code && t(error.code, locale) !== error.code
      ? t(error.code, locale)
      : (isOperational ? error.message : t('OK', locale) && 'Something went wrong.'),
    code: error.code || null,
    retryable: error.retryable ?? (statusCode >= 500),
    trace_id: req.traceId || null,
  };

  if (error.details) body.details = error.details;

  if (process.env.NODE_ENV === 'development') {
    body.stack = err.stack;
    body.raw = err.message;
  }

  res.status(statusCode >= 100 && statusCode < 600 ? statusCode : 500).json(body);
};
