
require('dotenv').config();

const db = require('../db/pool');
const logger = require('../utils/logger');
const { createSagaOrchestrator, visitCompleteSaga } = require('../services/sagaOrchestrator');
const metrics = require('../utils/metrics');

const sagaRepo = {
  async findStuck(type, olderThanMs) {
    const { rows } = await db.query(
      `SELECT * FROM sagas
        WHERE type = $1 AND state = 'running'
          AND updated_at < now() - ($2 || ' milliseconds')::interval
        FOR UPDATE SKIP LOCKED`,
      [type, olderThanMs]
    );
    return rows;
  },
  async setState(id, state, error = null) {
    await db.query(
      `UPDATE sagas SET state = $2, last_error = COALESCE($3, last_error) WHERE id = $1`,
      [id, state, error]
    );
  },
  async markStepCompensated(id, step) {
    await db.query(
      `UPDATE sagas SET compensated_steps = array_append(compensated_steps, $2) WHERE id = $1`,
      [id, step]
    );
  },
  async create() { throw new Error('recovery does not create sagas'); },
  async setCurrentStep() {},
  async mergeContext() {},
  async markStepCompleted() {},
};

async function run() {
  const saga = createSagaOrchestrator({
    db, sagaRepo, logger, metrics,
  });

  const def = visitCompleteSaga({
    orderService: null,
    paymentGateway: null,
    logisticsPartner: null,
    notifier: null,
    logger,
  });

  const n = await saga.recoverStuck(def, { olderThanMs: 60_000 });

  if (n > 0) {
    logger.warn({ recovered: n }, 'saga recovery: compensated stranded sagas');
  }

  await db.close();
  return n;
}

if (require.main === module) {
  run()
    .then((n) => { console.log(`recovered ${n}`); process.exit(0); })
    .catch((err) => { logger.fatal({ err }, 'saga recovery failed'); process.exit(1); });
}

module.exports = { run };
