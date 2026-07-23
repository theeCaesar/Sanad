const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { sendOk } = require('../utils/response');
const { z } = require('zod');
const { MUTATION_TYPES } = require('../constants');

const mutationSchema = z.object({
  mutation_id: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  type: z.enum(Object.values(MUTATION_TYPES)),
  entity_id: z.string().uuid().nullable().optional(),
  base_version: z.number().int().nonnegative().nullable().optional(),
  client_ts: z.string().datetime(),
  payload: z.record(z.any()).default({}),
  trace_id: z.string().optional(),
});

const pushSchema = z.object({
  mutations: z.array(mutationSchema).min(1).max(500),
});

const pullSchema = z.object({
  since: z.string().datetime().optional(),
});

function createSyncController({ syncService }) {
  const push = catchAsync(async (req, res, next) => {
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(new AppError('Invalid sync payload.', 400, {
        code: 'VALIDATION_FAILED',
        retryable: false,
        details: parsed.error.flatten(),
      }));
    }

    const result = await syncService.push(req.ctx, parsed.data.mutations);

    return sendOk(res, result, 'Synced.');
  });

  const pull = catchAsync(async (req, res, next) => {
    const parsed = pullSchema.safeParse(req.query);
    if (!parsed.success) {
      return next(new AppError('Invalid cursor.', 400, { code: 'VALIDATION_FAILED' }));
    }

    const changes = await syncService.pull(req.ctx, { since: parsed.data.since });
    return sendOk(res, changes, 'OK');
  });

  return { push, pull };
}

module.exports = { createSyncController, mutationSchema, pushSchema };
