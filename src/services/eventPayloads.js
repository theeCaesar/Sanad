

const { EVENTS } = require('../constants');

function withTimestamps(base, { clientTs, syncedAt }) {
  if (!clientTs) {
    throw new Error(
      'Event is missing `happened_at`. Every event MUST carry when it happened ' +
      'in the field, not just when it reached us. See docs/SYNC_PROTOCOL.md.'
    );
  }
  return {
    ...base,
    happened_at: clientTs,
    synced_at: syncedAt || new Date().toISOString(),
  };
}

const BUILDERS = {
  [EVENTS.JOB_ACCEPTED]: (d) => withTimestamps({
    event_type: EVENTS.JOB_ACCEPTED,
    org_id: d.orgId,
    entity_id: d.entityId,
    status: d.status,
    version: d.version,
    device_id: d.deviceId,
    user_id: d.userId,
    resolution: d.resolution || null,
  }, d),

  [EVENTS.JOB_PICKED_UP]: (d) => withTimestamps({
    event_type: EVENTS.JOB_PICKED_UP,
    org_id: d.orgId,
    entity_id: d.entityId,
    status: d.status,
    version: d.version,
    device_id: d.deviceId,
    user_id: d.userId,
    resolution: d.resolution || null,
  }, d),

  [EVENTS.JOB_DELIVERED]: (d) => withTimestamps({
    event_type: EVENTS.JOB_DELIVERED,
    org_id: d.orgId,
    entity_id: d.entityId,
    status: d.status || 'delivered',
    version: d.version,
    device_id: d.deviceId,
    user_id: d.userId,
    resolution: d.resolution || null,
  }, d),

  [EVENTS.JOB_FAILED]: (d) => withTimestamps({
    event_type: EVENTS.JOB_FAILED,
    org_id: d.orgId,
    entity_id: d.entityId,
    status: 'failed',
    version: d.version,
    failure_reason: d.failureReason || 'unspecified',
    device_id: d.deviceId,
    user_id: d.userId,
    resolution: d.resolution || null,
  }, d),

  [EVENTS.CASH_COLLECTED]: (d) => withTimestamps({
    event_type: EVENTS.CASH_COLLECTED,
    org_id: d.orgId,
    entity_id: d.entityId,
    amount: d.amount,
    device_id: d.deviceId,
    user_id: d.userId,
  }, d),

  [EVENTS.ORDER_CREATED]: (d) => withTimestamps({
    event_type: EVENTS.ORDER_CREATED,
    org_id: d.orgId,
    order_id: d.orderId,
    customer_id: d.customerId,
    total: d.total,
    paid: d.paid,
    device_id: d.deviceId,
    user_id: d.userId,
  }, d),

  [EVENTS.VISIT_COMPLETED]: (d) => withTimestamps({
    event_type: EVENTS.VISIT_COMPLETED,
    org_id: d.orgId,
    entity_id: d.entityId,
    status: 'completed',
    version: d.version,
    device_id: d.deviceId,
    user_id: d.userId,
  }, d),

  [EVENTS.STOCK_LOW]: (d) => ({
    event_type: EVENTS.STOCK_LOW,
    org_id: d.orgId,
    product_id: d.productId,
    user_id: d.userId,
    remaining: Number(d.remaining),
  }),

  [EVENTS.SYNC_CONFLICT_ESCALATED]: (d) => {
    if (!d.reason) {
      throw new Error(
        'An escalation MUST carry a human-readable reason. A dispatcher has to ' +
        'READ this. See docs/CONFLICT_RESOLUTION.md.'
      );
    }
    return {
      event_type: EVENTS.SYNC_CONFLICT_ESCALATED,
      org_id: d.orgId,
      entity_id: d.entityId,
      mutation_id: d.mutationId,
      device_id: d.deviceId,
      reason: d.reason,
      server_status: d.serverStatus,
      device_wanted: d.deviceWanted,
    };
  },
};

function buildEventPayload(eventType, data) {
  const builder = BUILDERS[eventType];
  if (!builder) {
    throw new Error(`Unknown event type "${eventType}". Add it to eventPayloads.js.`);
  }
  return builder(data);
}

module.exports = { buildEventPayload, BUILDERS, withTimestamps };
