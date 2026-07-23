

require('dotenv').config();

const { Kafka } = require('kafkajs');
const db = require('../db/pool');
const repo = require('../repositories/syncRepository');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { startMetricsServer } = require('../utils/metricsServer');
const { TOPICS, OUTBOX_STATUS } = require('../constants');

const METRICS_PORT = Number(process.env.METRICS_PORT || 9101);
const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 500);
const BATCH = Number(process.env.OUTBOX_BATCH || 100);
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 5);

let running = true;
let producer;

async function connectKafka() {
  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'sanad-outbox',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    retry: { initialRetryTime: 300, retries: 8 },
  });
  producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
    transactionalId: undefined,
  });
  await producer.connect();
  logger.info('outbox: kafka producer connected');
}

async function drainOnce() {
  return db.withTransaction(async (client) => {
    const events = await repo.claimPendingEvents(client, BATCH);
    if (events.length === 0) return 0;

    const publishedIds = [];

    const byTopic = new Map();
    for (const e of events) {
      if (!byTopic.has(e.topic)) byTopic.set(e.topic, []);
      byTopic.get(e.topic).push(e);
    }

    for (const [topic, batch] of byTopic) {
      try {
        await producer.send({
          topic,
          acks: -1,
          messages: batch.map((e) => ({
            key: e.partition_key,
            value: JSON.stringify({
              event_type: e.event_type,
              org_id: e.org_id,
              ...e.payload,
            }),
            headers: {
              'event-type': e.event_type,
              'org-id': String(e.org_id),
              'trace-id': e.trace_id || '',
              'outbox-id': String(e.id),
            },
          })),
        });

        for (const e of batch) publishedIds.push(e.id);
        metrics.outboxPublished.inc({ topic }, batch.length);
      } catch (err) {
        logger.error({ err: err.message, topic, count: batch.length }, 'outbox: publish failed');

        for (const e of batch) {
          const { status, attempts } = await repo.markFailed(client, e.id, err.message, MAX_ATTEMPTS);

          if (status === OUTBOX_STATUS.FAILED) {
            metrics.outboxDeadLettered.inc();
            logger.error(
              { outboxId: e.id, eventType: e.event_type, attempts, err: err.message },
              'outbox: DEAD LETTERED — this event will never be delivered. Investigate.'
            );
            try {
              await producer.send({
                topic: TOPICS.DLQ,
                messages: [{
                  key: e.partition_key,
                  value: JSON.stringify({
                    original_topic: e.topic,
                    event_type: e.event_type,
                    payload: e.payload,
                    error: err.message,
                    attempts,
                    dead_lettered_at: new Date().toISOString(),
                  }),
                }],
              });
            } catch (dlqErr) {
              logger.fatal({ err: dlqErr.message, outboxId: e.id }, 'outbox: DLQ unreachable');
            }
          }
        }
      }
    }

    await repo.markPublished(client, publishedIds);
    return publishedIds.length;
  });
}

async function updateGauges() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS pending,
            COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::int AS oldest_seconds
       FROM outbox WHERE status = 'pending'`
  );
  metrics.outboxPending.set(rows[0].pending);
  metrics.outboxAgeSeconds.set(rows[0].oldest_seconds);

  if (rows[0].oldest_seconds > 60) {
    logger.warn(
      { pending: rows[0].pending, oldest_seconds: rows[0].oldest_seconds },
      'outbox: BACKLOG — publisher is falling behind'
    );
  }
}

async function loop() {
  while (running) {
    try {
      const n = await drainOnce();
      await updateGauges();
      if (n === 0) await sleep(POLL_MS);
    } catch (err) {
      logger.error({ err: err.message }, 'outbox: loop error');
      await sleep(POLL_MS * 4);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shutdown(signal) {
  logger.info({ signal }, 'outbox: shutting down');
  running = false;
  await sleep(1500);
  try { await producer?.disconnect(); } catch {}
  await db.close();
  process.exit(0);
}

async function main() {
  await connectKafka();
  startMetricsServer(METRICS_PORT, 'outbox-publisher');
  logger.info({ batch: BATCH, pollMs: POLL_MS }, 'outbox: publisher started');
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await loop();
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'outbox: fatal');
    process.exit(1);
  });
}

module.exports = { drainOnce, updateGauges, connectKafka };
