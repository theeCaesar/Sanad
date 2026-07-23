const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const logger = require('../utils/logger');

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.cookies?.access_token) return req.cookies.access_token;
  return null;
}

function createAuthMiddleware({ authService, userRepo }) {
  const protect = catchAsync(async (req, res, next) => {
    const token = bearer(req);
    if (!token) {
      return next(new AppError('You are not logged in.', 401, { code: 'UNAUTHORIZED' }));
    }

    const claims = authService.verify(token, 'access');

    const user = await userRepo.findById(claims.org, claims.sub);
    if (!user || !user.active) {
      return next(new AppError('This account is disabled.', 401, { code: 'USER_INACTIVE' }));
    }
    if (Number(claims.tv) !== Number(user.token_version)) {
      return next(new AppError('Your session was revoked.', 401, { code: 'TOKEN_REVOKED' }));
    }

    req.user = user;
    req.ctx = {
      orgId: user.org_id,
      userId: user.id,
      role: user.role,
      locale: user.locale,
    };
    next();
  });

  const protectDevice = catchAsync(async (req, res, next) => {
    const token = bearer(req);
    if (!token) {
      return next(new AppError('Device token required.', 401, { code: 'UNAUTHORIZED' }));
    }

    const claims = authService.verify(token, 'device');

    const ctx = await authService.authorizeSync(claims);

    req.ctx = ctx;
    next();
  });

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.ctx?.role || !roles.includes(req.ctx.role)) {
      logger.warn(
        { userId: req.ctx?.userId, role: req.ctx?.role, needed: roles, route: req.originalUrl },
        'authz: role denied'
      );
      return next(new AppError('You do not have permission to do that.', 403, {
        code: 'FORBIDDEN',
      }));
    }
    next();
  };

  const scopeToOrg = (req, res, next) => {
    if (req.query.org_id || req.body?.org_id) {
      logger.error(
        { userId: req.ctx?.userId, attempted: req.query.org_id || req.body?.org_id },
        'authz: client attempted to specify org_id — refusing'
      );
      return next(new AppError('org_id may not be supplied by the client.', 400, {
        code: 'FORBIDDEN_PARAM',
      }));
    }
    next();
  };

  return { protect, protectDevice, requireRole, scopeToOrg };
}

module.exports = { createAuthMiddleware };
