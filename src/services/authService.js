const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const AppError = require('../utils/appError');

function createAuthService(deps) {
  const {
    userRepo,
    deviceRepo,
    logger,
    now = () => new Date(),
    secrets = {
      access: process.env.JWT_ACCESS_SECRET,
      refresh: process.env.JWT_REFRESH_SECRET,
    },
    ttl = {
      access: process.env.JWT_ACCESS_TTL || '15m',
      refresh: process.env.JWT_REFRESH_TTL || '30d',
      device: process.env.DEVICE_REFRESH_TTL || '90d',
    },
  } = deps;

  function signAccess(user) {
    return jwt.sign(
      {
        sub: user.id,
        org: user.org_id,
        role: user.role,
        tv: user.token_version,
      },
      secrets.access,
      { expiresIn: ttl.access, issuer: 'sanad', audience: 'sanad-api' }
    );
  }

  function signDevice(user, device) {
    return jwt.sign(
      {
        sub: user.id,
        org: user.org_id,
        role: user.role,
        dev: device.id,
        typ: 'device',
        tv: user.token_version,
      },
      secrets.refresh,
      { expiresIn: ttl.device, issuer: 'sanad', audience: 'sanad-sync' }
    );
  }

  function signRefresh(user) {
    return jwt.sign(
      { sub: user.id, org: user.org_id, tv: user.token_version, typ: 'refresh' },
      secrets.refresh,
      { expiresIn: ttl.refresh, issuer: 'sanad', audience: 'sanad-api' }
    );
  }

  function verify(token, kind = 'access') {
    const unverified = jwt.decode(token) || {};
    const typ = unverified.typ === 'device' || unverified.typ === 'refresh'
      ? unverified.typ
      : 'access';
    const secret = typ === 'access' ? secrets.access : secrets.refresh;
    const audience = typ === 'device' ? 'sanad-sync' : 'sanad-api';

    let claims;
    try {
      claims = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer: 'sanad',
        audience,
      });
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new AppError('Your session expired. Please sign in again.', 401, {
          code: 'TOKEN_EXPIRED',
          retryable: false,
        });
      }
      throw new AppError('Invalid token.', 401, { code: 'TOKEN_INVALID' });
    }

    const actualTyp = claims.typ || 'access';
    if (actualTyp !== kind) {
      throw new AppError(`Wrong token type for this endpoint (got "${actualTyp}").`, 401, {
        code: 'WRONG_TOKEN_TYPE',
      });
    }

    return claims;
  }

  async function login({ orgSlug, phone, password }) {
    const user = await userRepo.findByPhone(orgSlug, phone);

    const hash = user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok || !user.active) {
      logger.warn({ orgSlug, phone }, 'auth: failed login');
      throw new AppError('Invalid phone or password.', 401, { code: 'BAD_CREDENTIALS' });
    }

    return {
      user: publicUser(user),
      access_token: signAccess(user),
      refresh_token: signRefresh(user),
    };
  }

  async function registerDevice({ userId, orgId, label, platform }) {
    const user = await userRepo.findById(orgId, userId);
    if (!user) throw new AppError('User not found.', 404);

    const device = await deviceRepo.create({
      org_id: orgId, user_id: userId, label, platform,
    });

    logger.info({ userId, deviceId: device.id, platform }, 'auth: device registered');

    return {
      device: { id: device.id, label: device.label, last_applied_seq: 0 },
      device_token: signDevice(user, device),
      access_token: signAccess(user),
    };
  }

  async function authorizeSync(claims) {
    const [user, device] = await Promise.all([
      userRepo.findById(claims.org, claims.sub),
      deviceRepo.findById(claims.dev),
    ]);

    if (!user || !user.active) {
      throw new AppError('This account is disabled.', 401, { code: 'USER_INACTIVE' });
    }
    if (!device || device.revoked) {
      throw new AppError('This device has been revoked. Contact your dispatcher.', 401, {
        code: 'DEVICE_REVOKED',
        retryable: false,
      });
    }
    if (device.user_id !== user.id || device.org_id !== user.org_id) {
      logger.error({ claims, device }, 'auth: device/user mismatch — possible token forgery');
      throw new AppError('Invalid device.', 403, { code: 'DEVICE_MISMATCH' });
    }
    if (Number(claims.tv) !== Number(user.token_version)) {
      throw new AppError('Your session was revoked. Please sign in again.', 401, {
        code: 'TOKEN_REVOKED',
      });
    }

    return {
      orgId: user.org_id,
      userId: user.id,
      deviceId: device.id,
      role: user.role,
      locale: user.locale,
    };
  }

  async function revokeAllSessions(orgId, userId) {
    await userRepo.bumpTokenVersion(orgId, userId);
    logger.warn({ userId }, 'auth: all sessions revoked');
  }

  async function revokeDevice(orgId, deviceId) {
    await deviceRepo.revoke(orgId, deviceId);
    logger.warn({ deviceId }, 'auth: device revoked');
  }

  function publicUser(u) {
    return {
      id: u.id, name: u.name, phone: u.phone, role: u.role,
      org_id: u.org_id, locale: u.locale,
    };
  }

  return {
    login,
    registerDevice,
    authorizeSync,
    revokeAllSessions,
    revokeDevice,
    verify,
    signAccess,
    signDevice,
    signRefresh,
  };
}

module.exports = { createAuthService };
