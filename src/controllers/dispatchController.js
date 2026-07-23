const { z } = require('zod');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { sendOk, sendCreated, sendPaginated } = require('../utils/response');

const createJobSchema = z.object({
  ref: z.string().min(1).max(40),
  customer_id: z.string().uuid(),
  assigned_to: z.string().uuid().optional(),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  price: z.number().int().nonnegative().default(0),
  cod_amount: z.number().int().nonnegative().default(0),
  priority: z.number().int().min(0).max(9).default(0),
});

const updateJobSchema = z.object({
  assigned_to: z.string().uuid().nullable().optional(),
  priority: z.number().int().min(0).max(9).optional(),
  window_start: z.string().datetime().optional(),
  window_end: z.string().datetime().optional(),
  price: z.number().int().nonnegative().optional(),
  cancel: z.boolean().optional(),
  expected_version: z.number().int().optional(),
});

function createDispatchController({ jobRepo, deviceRepo, db, logger }) {
  const board = catchAsync(async (req, res) => {
    const { status, assigned_to: assignedTo, q, page = 1, limit = 50 } = req.query;
    const r = await jobRepo.listForOrg(req.ctx.orgId, {
      status, assignedTo, q, page: Number(page), limit: Math.min(Number(limit), 100),
    });
    return sendPaginated(res, r.items, r);
  });

  const createJob = catchAsync(async (req, res, next) => {
    const p = createJobSchema.safeParse(req.body);
    if (!p.success) {
      return next(new AppError('Invalid job.', 400, {
        code: 'VALIDATION_FAILED', details: p.error.flatten(),
      }));
    }

    const job = await db.withTransaction((c) =>
      jobRepo.create(c, { ...p.data, org_id: req.ctx.orgId })
    );
    return sendCreated(res, job, 'Job created.');
  });

  const updateJob = catchAsync(async (req, res, next) => {
    const p = updateJobSchema.safeParse(req.body);
    if (!p.success) {
      return next(new AppError('Invalid update.', 400, { code: 'VALIDATION_FAILED' }));
    }

    const { cancel, expected_version: expectedVersion, ...fields } = p.data;
    if (cancel) fields.status = 'cancelled';

    if (!Object.keys(fields).length) {
      return next(new AppError('Nothing to update.', 400, { code: 'VALIDATION_FAILED' }));
    }

    const result = await db.withTransaction((c) =>
      jobRepo.officeUpdate(c, {
        orgId: req.ctx.orgId,
        id: req.params.id,
        fields,
        actorId: req.ctx.userId,
        expectedVersion,
      })
    );

    if (result.rowCount === 0) {
      const current = await jobRepo.findById(req.ctx.orgId, req.params.id);
      if (!current) return next(new AppError('Not found.', 404, { code: 'NOT_FOUND' }));

      return next(new AppError(
        `This job changed while you were editing it (you had version ${expectedVersion}, `
        + `it is now version ${current.version}, status "${current.status}"). `
        + `A driver's sync may have just landed. Reload and try again.`,
        409,
        { code: 'STALE_WRITE', retryable: true, details: { current } }
      ));
    }

    return sendOk(res, result.row, 'Updated.');
  });

  const conflicts = catchAsync(async (req, res) => {
    const rows = await jobRepo.listEscalations(req.ctx.orgId, {
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 50),
    });
    return sendOk(res, {
      items: rows,
      explain:
        'These are conflicts the resolver would not decide on principle. Each has the '
        + 'device\'s version and the server\'s version attached. A human decides. The '
        + 'system deliberately did NOT act — guessing silently is how systems lose money.',
    });
  });

  const resolveConflict = catchAsync(async (req, res, next) => {
    const choice = req.body?.choose;
    if (!['device', 'server'].includes(choice)) {
      return next(new AppError('choose must be "device" or "server".', 400, {
        code: 'VALIDATION_FAILED',
      }));
    }

    const out = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM mutations WHERE mutation_id = $1 AND org_id = $2`,
        [req.params.mutationId, req.ctx.orgId]
      );
      const m = rows[0];
      if (!m) throw new AppError('Not found.', 404, { code: 'NOT_FOUND' });
      if (m.resolution !== 'escalated') {
        throw new AppError('That conflict is not open.', 409, { code: 'ALREADY_RESOLVED' });
      }

      if (choice === 'device') {
        await client.query(
          `UPDATE jobs SET status = $2, version = version + 1
            WHERE id = $1 AND org_id = $3`,
          [m.entity_id, m.payload.status, req.ctx.orgId]
        );
      }

      await client.query(
        `UPDATE mutations
            SET resolution = $2,
                resolution_reason = resolution_reason ||
                  ' | MANUALLY RESOLVED by ' || $3 || ': chose ' || $4
          WHERE mutation_id = $1`,
        [
          req.params.mutationId,
          choice === 'device' ? 'field_wins' : 'server_wins',
          req.ctx.userId,
          choice,
        ]
      );

      logger.warn(
        { mutationId: req.params.mutationId, choice, by: req.ctx.userId },
        'dispatch: conflict manually resolved'
      );

      return { mutation_id: req.params.mutationId, chose: choice };
    });

    return sendOk(res, out, 'Conflict resolved.');
  });

  const deviceHealth = catchAsync(async (req, res) => {
    const rows = await deviceRepo.listWithHealth(req.ctx.orgId);
    return sendOk(res, {
      devices: rows.map((d) => ({
        ...d,
        health: d.revoked ? 'revoked'
          : d.dark_seconds == null ? 'never_synced'
          : d.dark_seconds < 300 ? 'online'
          : d.dark_seconds < 3600 ? 'dark'
          : 'long_dark',
      })),
      explain:
        'A device that is "dark" is not necessarily broken — that is the normal '
        + 'condition in the field. What matters is whether it comes back. A device in '
        + 'long_dark is carrying unsynced work that nobody can see yet.',
    });
  });

  return { board, createJob, updateJob, conflicts, resolveConflict, deviceHealth };
}

module.exports = { createDispatchController };
