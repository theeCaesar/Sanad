const catchAsync = require('../utils/catchAsync');
const { sendOk } = require('../utils/response');

function createReportController({ reportRepo }) {
  const range = (q) => ({
    from: q.from || new Date(Date.now() - 30 * 864e5).toISOString(),
    to: q.to || new Date().toISOString(),
  });

  const cash = catchAsync(async (req, res) => {
    const rows = await reportRepo.cashByDriver(req.ctx.orgId, range(req.query));
    return sendOk(res, {
      rows,
      total_outstanding: rows.reduce((s, r) => s + Number(r.outstanding), 0),
      explain:
        'Every row here is derived from an append-only ledger where mutation_id is '
        + 'UNIQUE. A driver who syncs the same batch twice on a bad network cannot '
        + 'double-count a cash collection — the database refuses the second insert.',
    });
  });

  const darkTime = catchAsync(async (req, res) => {
    const rows = await reportRepo.darkTime(req.ctx.orgId, range(req.query));
    return sendOk(res, {
      rows,
      explain:
        'Dark time = received_at − client_ts. The gap between the world and the '
        + 'database. p95 is the honest number; the average hides the six-hour outliers '
        + 'that are the entire reason this system exists.',
    });
  });

  const conflicts = catchAsync(async (req, res) => {
    const rows = await reportRepo.conflictStats(req.ctx.orgId, range(req.query));
    const total = rows.reduce((s, r) => s + r.count, 0);
    const escalated = rows.find((r) => r.resolution === 'escalated')?.count || 0;

    return sendOk(res, {
      rows,
      total,
      escalation_rate: total ? (escalated / total) : 0,
      explain:
        'A RISING escalation rate is a signal that the resolution rules do not cover '
        + 'a case that keeps happening in the real world — the system telling you, '
        + 'honestly, that it does not know something. That is a feature. The failure '
        + 'mode to fear is an escalation rate of zero achieved by guessing.',
    });
  });

  return { cash, darkTime, conflicts };
}

module.exports = { createReportController };
