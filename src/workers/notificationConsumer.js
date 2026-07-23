

require('dotenv').config();

const { Kafka } = require('kafkajs');
const db = require('../db/pool');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { startMetricsServer } = require('../utils/metricsServer');
const { TOPICS, EVENTS } = require('../constants');
const { t } = require('../utils/i18n');

const METRICS_PORT = Number(process.env.METRICS_PORT || 9101);
const GROUP = process.env.CONSUMER_GROUP || 'sanad-notifications';
const MAX_RETRIES = 3;

let consumer;
let producer;
let running = true;

async function claimEvent(client, { eventId, group }) {
  const { rowCount } = await client.query(
    `INSERT INTO processed_events (event_id, consumer_group, processed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (event_id, consumer_group) DO NOTHING`,
    [eventId, group]
  );
  return rowCount === 1;
}

const handlers = {
  [EVENTS.JOB_DELIVERED]: async (client, evt) => {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, key, params, severity)
       SELECT $1, j.assigned_to, 'JOB_DELIVERED',
              jsonb_build_object('ref', j.ref, 'at', $3::text), 'info'
         FROM jobs j WHERE j.id = $2`,
      [evt.org_id, evt.entity_id, evt.happened_at]
    );
    metrics.jobsDelivered.inc();

    const darkSeconds =
      (new Date(evt.synced_at) - new Date(evt.happened_at)) / 1000;
    if (darkSeconds > 3600) {
      logger.info(
        { jobId: evt.entity_id, darkHours: (darkSeconds / 3600).toFixed(1) },
        'consumer: delivery synced after a long dark period'
      );
    }
    metrics.syncDarkSeconds.observe({ module: 'delivery' }, darkSeconds);
  },

  [EVENTS.JOB_FAILED]: async (client, evt) => {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, key, params, severity)
       SELECT $1, u.id, 'JOB_FAILED', jsonb_build_object('ref', j.ref), 'warn'
         FROM jobs j, users u
        WHERE j.id = $2 AND u.org_id = $1 AND u.role = 'dispatcher'`,
      [evt.org_id, evt.entity_id]
    );
  },

  [EVENTS.STOCK_LOW]: async (client, evt) => {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, key, params, severity)
       VALUES ($1, $2, 'STOCK_LOW',
               jsonb_build_object('product', $3::text, 'remaining', $4::int), 'warn')`,
      [evt.org_id, evt.user_id, evt.product_id, evt.remaining]
    );
  },

  [EVENTS.SYNC_CONFLICT_ESCALATED]: async (client, evt) => {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, key, params, severity)
       SELECT $1, u.id, 'CONFLICT_NEEDS_REVIEW',
              jsonb_build_object('ref', $2::text, 'reason', $3::text), 'critical'
         FROM users u WHERE u.org_id = $1 AND u.role = 'dispatcher'`,
      [evt.org_id, evt.entity_id, evt.reason]
    );
    logger.warn({ entityId: evt.entity_id }, 'consumer: conflict escalated to dispatcher');
  },

  [EVENTS.ORDER_CREATED]: async (client, evt) => {
    await client.query(
      `UPDATE customers SET balance = balance + $2 WHERE id = $1`,
      [evt.customer_id, evt.total - evt.paid]
    );
  },
};

async function handleMessage({ topic, partition, message }) {
  const evt = JSON.parse(message.value.toString());
  const eventType = message.headers?.['event-type']?.toString() || evt.event_type;
  const traceId = message.headers?.['trace-id']?.toString();
  const outboxId = message.headers?.['outbox-id']?.toString();

  const log = logger.child({ trace_id: traceId, event_type: eventType, topic, partition });

  const handler = handlers[eventType];
  if (!handler) {
    return;
  }

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      await db.withTransaction(async (client) => {
        const claimed = await claimEvent(client, {
          eventId: outboxId || `${topic}:${partition}:${message.offset}`,
          group: GROUP,
        });

        if (!claimed) {
          log.debug({ outboxId }, 'consumer: duplicate absorbed');
          return;
        }

        await handler(client, evt);
      });

      return;
    } catch (err) {
      attempt += 1;
      log.error({ err: err.message, attempt }, 'consumer: handler failed');

      if (attempt >= MAX_RETRIES) {
        await producer.send({
          topic: TOPICS.DLQ,
          messages: [{
            key: message.key,
            value: JSON.stringify({
              original_topic: topic,
              event_type: eventType,
              payload: evt,
              error: err.message,
              attempts: attempt,
              consumer_group: GROUP,
              trace_id: traceId,
              dead_lettered_at: new Date().toISOString(),
            }),
          }],
        });

        log.error({ outboxId, err: err.message }, 'consumer: DEAD LETTERED — moving on');
        return;
      }

      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
  }
}

async function main() {
  const kafka = new Kafka({
    clientId: `${process.env.KAFKA_CLIENT_ID || 'sanad'}-consumer`,
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  });

  consumer = kafka.consumer({ groupId: GROUP, sessionTimeout: 30000 });
  producer = kafka.producer();

  await consumer.connect();
  await producer.connect();

  await consumer.subscribe({
    topics: [TOPICS.JOBS, TOPICS.SALES, TOPICS.INVENTORY, TOPICS.NOTIFICATIONS],
    fromBeginning: false,
  });

  startMetricsServer(METRICS_PORT, 'notification-consumer');
  logger.info({ group: GROUP }, 'consumer: started');

  await consumer.run({
    eachMessage: handleMessage,
    autoCommit: true,
  });

  const shutdown = async (sig) => {
    logger.info({ sig }, 'consumer: shutting down');
    running = false;
    await consumer.disconnect();
    await producer.disconnect();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'consumer: fatal');
    process.exit(1);
  });
}

module.exports = { handleMessage, handlers, claimEvent };
