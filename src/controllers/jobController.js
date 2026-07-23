const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { sendOk, sendPaginated } = require('../utils/response');

function createJobController({ jobRepo }) {
  const listMine = catchAsync(async (req, res) => {
    const { status, page = 1, limit = 50 } = req.query;
    const r = await jobRepo.listForDriver(req.ctx.orgId, req.ctx.userId, {
      status, page: Number(page), limit: Math.min(Number(limit), 100),
    });
    return sendPaginated(res, r.items, r);
  });

  const getOne = catchAsync(async (req, res, next) => {
    const job = await jobRepo.findById(req.ctx.orgId, req.params.id);
    if (!job) return next(new AppError('Not found.', 404, { code: 'NOT_FOUND' }));

    if (req.ctx.role === 'driver' && job.assigned_to !== req.ctx.userId) {
      return next(new AppError('This item is not assigned to you.', 403, {
        code: 'NOT_ASSIGNED_TO_YOU',
      }));
    }

    return sendOk(res, job);
  });

  const history = catchAsync(async (req, res, next) => {
    const job = await jobRepo.findById(req.ctx.orgId, req.params.id);
    if (!job) return next(new AppError('Not found.', 404, { code: 'NOT_FOUND' }));
    if (req.ctx.role === 'driver' && job.assigned_to !== req.ctx.userId) {
      return next(new AppError('This item is not assigned to you.', 403, {
        code: 'NOT_ASSIGNED_TO_YOU',
      }));
    }

    const events = await jobRepo.history(req.ctx.orgId, req.params.id);
    return sendOk(res, {
      job,
      timeline: events.map((e) => ({
        ...e,
        dark_time_human: humanDuration(e.dark_seconds),
      })),
    });
  });

  return { listMine, getOne, history };
}

function humanDuration(seconds) {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

module.exports = { createJobController };
