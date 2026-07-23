const logger = require('../utils/logger');

function createRealtime(io, container) {
  const { authService, repos } = container;

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) return next(new Error('UNAUTHORIZED'));

      const claims = authService.verify(token, 'access');

      const user = await repos.userRepo.findById(claims.org, claims.sub);
      if (!user || !user.active) return next(new Error('USER_INACTIVE'));
      if (Number(claims.tv) !== Number(user.token_version)) {
        return next(new Error('TOKEN_REVOKED'));
      }

      socket.ctx = {
        orgId: user.org_id,
        userId: user.id,
        role: user.role,
      };
      next();
    } catch (err) {
      logger.warn({ err: err.message }, 'socket: auth rejected');
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { orgId, userId, role } = socket.ctx;

    socket.join(`org:${orgId}`);

    if (role === 'dispatcher' || role === 'admin') {
      socket.join(`org:${orgId}:dispatch`);
    } else {
      socket.join(`org:${orgId}:user:${userId}`);
    }

    logger.debug({ userId, role, orgId }, 'socket: connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ userId, reason }, 'socket: disconnected');
    });
  });

  const emit = {
    jobUpdated(orgId, job, meta = {}) {
      io.to(`org:${orgId}:dispatch`).emit('job:updated', { job, ...meta });
      if (job.assigned_to) {
        io.to(`org:${orgId}:user:${job.assigned_to}`).emit('job:updated', { job });
      }
    },

    conflict(orgId, payload) {
      io.to(`org:${orgId}:dispatch`).emit('sync:conflict', {
        ...payload,
        explain: payload.reason,
      });
    },

    escalation(orgId, payload) {
      io.to(`org:${orgId}:dispatch`).emit('sync:escalation', payload);
    },

    deviceSynced(orgId, { deviceId, userId, applied, conflicted, darkSeconds }) {
      io.to(`org:${orgId}:dispatch`).emit('device:synced', {
        device_id: deviceId,
        user_id: userId,
        applied,
        conflicted,
        dark_seconds: darkSeconds,
      });
    },

    driverLocation(orgId, { userId, lat, lng, at }) {
      io.to(`org:${orgId}:dispatch`).emit('driver:location', { userId, lat, lng, at });
    },
  };

  return { io, emit };
}

module.exports = { createRealtime };
