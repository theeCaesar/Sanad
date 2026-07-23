const { z } = require('zod');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { sendOk, sendCreated } = require('../utils/response');

const loginSchema = z.object({
  org: z.string().min(1),
  phone: z.string().min(6),
  password: z.string().min(8),
});

const deviceSchema = z.object({
  label: z.string().max(80).optional(),
  platform: z.enum(['android', 'ios', 'web']).optional(),
});

function createAuthController({ authService }) {
  const login = catchAsync(async (req, res, next) => {
    const p = loginSchema.safeParse(req.body);
    if (!p.success) return next(new AppError('Invalid credentials.', 400, { code: 'VALIDATION_FAILED' }));

    const result = await authService.login({
      orgSlug: p.data.org, phone: p.data.phone, password: p.data.password,
    });

    res.cookie('access_token', result.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });

    return sendOk(res, result, 'Signed in.');
  });

  const registerDevice = catchAsync(async (req, res, next) => {
    const p = deviceSchema.safeParse(req.body);
    if (!p.success) return next(new AppError('Invalid device.', 400, { code: 'VALIDATION_FAILED' }));

    const result = await authService.registerDevice({
      userId: req.ctx.userId,
      orgId: req.ctx.orgId,
      label: p.data.label,
      platform: p.data.platform,
    });

    return sendCreated(res, result, 'Device registered.');
  });

  const revokeDevice = catchAsync(async (req, res) => {
    await authService.revokeDevice(req.ctx.orgId, req.params.id);
    return sendOk(res, null, 'Device revoked. It will be refused on its next sync.');
  });

  return { login, registerDevice, revokeDevice };
}

module.exports = { createAuthController };
