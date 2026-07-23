const client = require('prom-client');

const register = new client.Registry();
register.setDefaultLabels({ service: 'sanad' });
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in ms',
  labelNames: ['method', 'route', 'status'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

const syncLatency = new client.Histogram({
  name: 'sync_batch_duration_ms',
  help: 'Time to process one full sync batch',
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [register],
});

const syncBatchSize = new client.Histogram({
  name: 'sync_batch_size',
  help: 'Mutations per sync batch',
  buckets: [1, 5, 10, 25, 50, 100, 200, 500],
  registers: [register],
});

const syncDarkSeconds = new client.Histogram({
  name: 'sync_dark_seconds',
  help: 'Seconds between client_ts (it happened) and received_at (we heard)',
  labelNames: ['module'],
  buckets: [1, 10, 60, 300, 900, 1800, 3600, 7200, 21600, 43200],
  registers: [register],
});

const syncConflicts = new client.Counter({
  name: 'sync_conflicts_total',
  help: 'Conflicts, by how they were resolved',
  labelNames: ['resolution'],
  registers: [register],
});

const syncDuplicates = new client.Counter({
  name: 'sync_duplicates_total',
  help: 'Mutations rejected as already-seen. High = flaky network, working as designed.',
  registers: [register],
});

const syncErrors = new client.Counter({
  name: 'sync_errors_total',
  help: 'Mutations that failed with a server error',
  registers: [register],
});

const syncRejected = new client.Counter({
  name: 'sync_rejected_total',
  help: 'Mutations rejected (illegal transition, authz, validation)',
  labelNames: ['reason'],
  registers: [register],
});

const outboxPending = new client.Gauge({
  name: 'outbox_pending',
  help: 'Events written but not yet published to Kafka',
  registers: [register],
});

const outboxPublished = new client.Counter({
  name: 'outbox_published_total',
  help: 'Events published to Kafka',
  labelNames: ['topic'],
  registers: [register],
});

const outboxDeadLettered = new client.Counter({
  name: 'outbox_dead_lettered_total',
  help: 'Events that exhausted retries. Should be zero. If not, page someone.',
  registers: [register],
});

const outboxAgeSeconds = new client.Gauge({
  name: 'outbox_oldest_pending_seconds',
  help: 'Age of the oldest unpublished event',
  registers: [register],
});

const sagaCompleted = new client.Counter({
  name: 'saga_completed_total',
  help: 'Sagas that ran to completion',
  labelNames: ['type'],
  registers: [register],
});

const sagaCompensated = new client.Counter({
  name: 'saga_compensated_total',
  help: 'Sagas that failed and rolled back. Non-zero is NORMAL — it means the design works.',
  labelNames: ['type', 'failed_step'],
  registers: [register],
});

const jobsDelivered = new client.Counter({
  name: 'jobs_delivered_total',
  help: 'Deliveries completed',
  registers: [register],
});

const cashOutstanding = new client.Gauge({
  name: 'cash_outstanding_iqd',
  help: 'Cash collected by drivers but not yet remitted',
  registers: [register],
});

module.exports = {
  register,
  httpDuration,
  syncLatency,
  syncBatchSize,
  syncDarkSeconds,
  syncConflicts,
  syncDuplicates,
  syncErrors,
  syncRejected,
  outboxPending,
  outboxPublished,
  outboxDeadLettered,
  outboxAgeSeconds,
  sagaCompleted,
  sagaCompensated,
  jobsDelivered,
  cashOutstanding,
};
