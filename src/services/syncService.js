

const {
  resolve,
  detectConflict,
  isLegalTransition,
  orderMutations,
  partitionByIdempotency,
  OUTCOME,
  RESOLUTION,
} = require('./conflictResolver');

const { buildEventPayload } = require('./eventPayloads');
const AppError = require('../utils/appError');

const {
  JOB_STATUS,
  VISIT_STATUS,
  JOB_TRANSITIONS,
  VISIT_TRANSITIONS,
  MUTATION_TYPES,
  EVENTS,
  TOPICS,
} = require('../constants');

const SPEC = Object.freeze({
  [MUTATION_TYPES.JOB_ACCEPT]: {
    entity: 'job', targetStatus: JOB_STATUS.ACCEPTED,
    fields: (p) => ({ status: JOB_STATUS.ACCEPTED, accepted_at: p.client_ts }),
    event: EVENTS.JOB_ACCEPTED, topic: TOPICS.JOBS,
  },
  [MUTATION_TYPES.JOB_PICKUP]: {
    entity: 'job', targetStatus: JOB_STATUS.PICKED_UP,
    fields: (p) => ({ status: JOB_STATUS.PICKED_UP, picked_up_at: p.client_ts }),
    event: EVENTS.JOB_PICKED_UP, topic: TOPICS.JOBS,
  },
  [MUTATION_TYPES.JOB_DELIVER]: {
    entity: 'job', targetStatus: JOB_STATUS.DELIVERED,
    fields: (p) => ({
      status: JOB_STATUS.DELIVERED,
      delivered_at: p.client_ts,
      recipient_name: p.recipient_name ?? null,
      proof_media_key: p.proof_media_key ?? null,
      delivered_lat: p.lat ?? null,
      delivered_lng: p.lng ?? null,
      field_note: p.note ?? null,
    }),
    event: EVENTS.JOB_DELIVERED, topic: TOPICS.JOBS,
  },
  [MUTATION_TYPES.JOB_FAIL]: {
    entity: 'job', targetStatus: JOB_STATUS.FAILED,
    fields: (p) => ({
      status: JOB_STATUS.FAILED,
      failure_reason: p.reason ?? 'unspecified',
      field_note: p.note ?? null,
    }),
    event: EVENTS.JOB_FAILED, topic: TOPICS.JOBS,
  },
  [MUTATION_TYPES.CASH_COLLECT]: {
    entity: 'job', targetStatus: null,
    fields: (p) => ({ cash_collected: p.amount }),
    event: EVENTS.CASH_COLLECTED, topic: TOPICS.JOBS,
    sideEffect: 'cash',
  },
  [MUTATION_TYPES.PROOF_ATTACH]: {
    entity: 'job', targetStatus: null,
    fields: (p) => ({ proof_media_key: p.media_key }),
    event: null, topic: null,
  },
  [MUTATION_TYPES.VISIT_CHECKIN]: {
    entity: 'visit', targetStatus: VISIT_STATUS.CHECKED_IN,
    fields: (p) => ({
      status: VISIT_STATUS.CHECKED_IN,
      checked_in_at: p.client_ts,
      checkin_lat: p.lat ?? null,
      checkin_lng: p.lng ?? null,
    }),
    event: null, topic: null,
  },
  [MUTATION_TYPES.VISIT_COMPLETE]: {
    entity: 'visit', targetStatus: VISIT_STATUS.COMPLETED,
    fields: (p) => ({ status: VISIT_STATUS.COMPLETED, completed_at: p.client_ts }),
    event: EVENTS.VISIT_COMPLETED, topic: TOPICS.SALES,
  },
  [MUTATION_TYPES.VISIT_SKIP]: {
    entity: 'visit', targetStatus: VISIT_STATUS.SKIPPED,
    fields: (p) => ({ status: VISIT_STATUS.SKIPPED, skip_reason: p.reason ?? 'unspecified' }),
    event: null, topic: null,
  },
  [MUTATION_TYPES.ORDER_CREATE]: {
    entity: 'order', targetStatus: null, special: 'order_create',
    event: EVENTS.ORDER_CREATED, topic: TOPICS.SALES,
  },
  [MUTATION_TYPES.PAYMENT_COLLECT]: {
    entity: 'order', targetStatus: null, special: 'payment',
    event: null, topic: null,
  },
});

const TRANSITIONS = { job: JOB_TRANSITIONS, visit: VISIT_TRANSITIONS };

function createSyncService(deps) {
  const {
    db,
    repo,
    logger,
    now = () => new Date(),
    uuid,
    metrics = null,
  } = deps;

  async function push(ctx, mutations) {
    const { orgId, userId, deviceId } = ctx;
    const started = Date.now();

    const ordered = orderMutations(mutations);

    const ids = ordered.map((m) => m.mutation_id);
    const seen = await db.withTransaction((c) => repo.findSeenMutationIds(c, ids));
    const { fresh, duplicates } = partitionByIdempotency(ordered, seen);

    const results = [];

    if (duplicates.length) {
      const prior = await db.withTransaction((c) =>
        repo.getMutationResults(c, duplicates.map((d) => d.mutation_id))
      );
      const byId = new Map(prior.map((p) => [p.mutation_id, p]));
      for (const d of duplicates) {
        const p = byId.get(d.mutation_id);
        results.push({
          mutation_id: d.mutation_id,
          outcome: OUTCOME.DUPLICATE,
          resolution: p?.resolution ?? null,
          reason: p
            ? `Already processed. Original outcome: ${p.outcome}. ${p.resolution_reason || ''}`.trim()
            : 'Already processed.',
          version: p?.server_version_after ?? null,
          entity_id: p?.entity_id ?? d.entity_id ?? null,
        });
      }
      metrics?.syncDuplicates?.inc(duplicates.length);
    }

    for (const m of fresh) {
      try {
        const r = await applyOne({ orgId, userId, deviceId }, m);
        results.push(r);
      } catch (err) {
        logger.error({ err, mutation_id: m.mutation_id, type: m.type }, 'sync: mutation failed');
        metrics?.syncErrors?.inc();
        results.push({
          mutation_id: m.mutation_id,
          outcome: OUTCOME.REJECTED,
          resolution: null,
          reason: `Server error while applying: ${err.message}`,
          retryable: true,
          version: null,
        });
      }
    }

    const applied = results.filter((r) => r.outcome === OUTCOME.APPLIED).length;
    const conflicted = results.filter((r) => r.outcome === OUTCOME.CONFLICT).length;

    metrics?.syncBatchSize?.observe(mutations.length);
    metrics?.syncLatency?.observe(Date.now() - started);

    logger.info(
      { deviceId, total: mutations.length, applied, conflicted,
        duplicates: duplicates.length, ms: Date.now() - started },
      'sync: batch complete'
    );

    return {
      results,
      summary: {
        received: mutations.length,
        applied,
        conflicted,
        duplicates: duplicates.length,
        rejected: results.filter((r) => r.outcome === OUTCOME.REJECTED).length,
      },
      server_time: now().toISOString(),
    };
  }

  async function applyOne(ctx, m) {
    const spec = SPEC[m.type];
    if (!spec) {
      return reject(ctx, m, `Unknown mutation type "${m.type}".`);
    }

    if (spec.special === 'order_create') return applyOrderCreate(ctx, m, spec);

    return db.withTransaction(async (client) => {
      const row = await repo.lockEntity(client, spec.entity, ctx.orgId, m.entity_id);

      if (!row) {
        return recordAndReturn(client, ctx, m, {
          outcome: OUTCOME.REJECTED,
          reason: `${spec.entity} ${m.entity_id} not found in this org.`,
        });
      }

      const conflicted = detectConflict({
        baseVersion: m.base_version,
        serverVersion: row.version,
      });

      const wasLegitimatelyAssigned = conflicted && row.previous_assigned_to === ctx.userId;

      if (row.assigned_to && row.assigned_to !== ctx.userId && !wasLegitimatelyAssigned) {
        logger.warn(
          { userId: ctx.userId, entity: spec.entity, id: m.entity_id, owner: row.assigned_to },
          'sync: BOLA attempt — user mutating a row assigned to someone else'
        );
        return recordAndReturn(client, ctx, m, {
          outcome: OUTCOME.REJECTED,
          reason: 'This item is not assigned to you.',
          serverVersionBefore: row.version,
        });
      }

      const payload = { ...m.payload, client_ts: m.client_ts };
      const fields = spec.fields ? spec.fields(payload) : {};
      const fieldKeys = Object.keys(fields);

      let resolution = null;
      let reason = null;
      let force = false;

      if (conflicted) {
        const serverChanged = await repo.fieldsChangedSince(
          client, spec.entity, m.entity_id, m.base_version
        );

        const decision = resolve({
          entity: spec.entity,
          deviceFields: fieldKeys,
          deviceTargetStatus: spec.targetStatus,
          serverStatus: row.status,
          serverChangedFields: serverChanged,
        });

        resolution = decision.resolution;
        reason = decision.reason;
        metrics?.syncConflicts?.inc({ resolution });

        if (decision.escalate) {
          await repo.enqueueEvent(client, {
            orgId: ctx.orgId,
            topic: TOPICS.NOTIFICATIONS,
            eventType: EVENTS.SYNC_CONFLICT_ESCALATED,
            partitionKey: String(m.entity_id),
            payload: buildEventPayload(EVENTS.SYNC_CONFLICT_ESCALATED, {
              orgId: ctx.orgId,
              entityId: m.entity_id,
              mutationId: m.mutation_id,
              deviceId: ctx.deviceId,
              deviceWanted: fields,
              serverStatus: row.status,
              reason,
            }),
            traceId: m.trace_id,
          });
          return recordAndReturn(client, ctx, m, {
            outcome: OUTCOME.CONFLICT,
            resolution: RESOLUTION.ESCALATED,
            reason,
            serverVersionBefore: row.version,
            serverVersionAfter: row.version,
          });
        }

        if (decision.winner === 'server') {
          return recordAndReturn(client, ctx, m, {
            outcome: OUTCOME.CONFLICT,
            resolution: decision.resolution,
            reason,
            serverVersionBefore: row.version,
            serverVersionAfter: row.version,
          });
        }

        force = true;
      }

      if (spec.targetStatus && !force) {
        const table = TRANSITIONS[spec.entity];
        if (!isLegalTransition(table, row.status, spec.targetStatus)) {
          return recordAndReturn(client, ctx, m, {
            outcome: OUTCOME.REJECTED,
            reason:
              `Illegal transition ${row.status} → ${spec.targetStatus}. ` +
              (reason ? `(after conflict resolution: ${reason})` : ''),
            resolution,
            serverVersionBefore: row.version,
          });
        }
      }

      const { rowCount, row: updated } = await repo.applyEntityUpdate(client, {
        entity: spec.entity,
        orgId: ctx.orgId,
        id: m.entity_id,
        fields,
        expectedVersion: force ? null : row.version,
        mutationId: m.mutation_id,
        deviceId: ctx.deviceId,
      });

      if (rowCount === 0) {
        throw new Error('Optimistic lock failed after row lock — investigate.');
      }

      if (spec.sideEffect === 'cash' && payload.amount) {
        await repo.insertCashEntry(client, {
          org_id: ctx.orgId,
          user_id: ctx.userId,
          job_id: m.entity_id,
          amount: payload.amount,
          kind: 'collect',
          mutation_id: m.mutation_id,
          client_ts: m.client_ts,
        });
      }

      if (spec.event) {
        await repo.enqueueEvent(client, {
          orgId: ctx.orgId,
          topic: spec.topic,
          eventType: spec.event,
          partitionKey: String(m.entity_id),
          payload: buildEventPayload(spec.event, {
            orgId: ctx.orgId,
            entityId: m.entity_id,
            status: updated.status,
            version: updated.version,
            clientTs: m.client_ts,
            syncedAt: now().toISOString(),
            deviceId: ctx.deviceId,
            userId: ctx.userId,
            amount: payload.amount,
            failureReason: fields.failure_reason,
            resolution,
          }),
          traceId: m.trace_id,
        });
      }

      await repo.bumpDeviceSeq(client, ctx.deviceId, m.seq);

      return recordAndReturn(client, ctx, m, {
        outcome: conflicted ? OUTCOME.CONFLICT : OUTCOME.APPLIED,
        resolution,
        reason: reason || 'Applied cleanly.',
        serverVersionBefore: row.version,
        serverVersionAfter: updated.version,
      });
    });
  }

  async function applyOrderCreate(ctx, m, spec) {
    return db.withTransaction(async (client) => {
      const p = m.payload;
      const lines = p.lines || [];

      if (!lines.length) {
        return recordAndReturn(client, ctx, m, {
          outcome: OUTCOME.REJECTED,
          reason: 'Order has no lines.',
        });
      }

      const products = await repo.getProducts(client, ctx.orgId, lines.map((l) => l.product_id));
      const byId = new Map(products.map((x) => [x.id, x]));

      let subtotal = 0;
      const priced = [];
      for (const l of lines) {
        const prod = byId.get(l.product_id);
        if (!prod) {
          return recordAndReturn(client, ctx, m, {
            outcome: OUTCOME.REJECTED,
            reason: `Unknown product ${l.product_id}.`,
          });
        }
        const lineTotal = prod.unit_price * l.qty;
        subtotal += lineTotal;
        priced.push({
          product_id: prod.id, qty: l.qty,
          unit_price: prod.unit_price, line_total: lineTotal,
        });
      }

      const discount = Math.max(0, Math.min(Number(p.discount || 0), subtotal));
      const total = subtotal - discount;
      const paid = Math.max(0, Math.min(Number(p.paid || 0), total));

      await client.query('SAVEPOINT order_create');

      try {
        for (const l of priced) {
          const { ok, remaining } = await repo.decrementVanStock(client, {
            orgId: ctx.orgId, userId: ctx.userId,
            productId: l.product_id, qty: l.qty,
          });
          if (!ok) {
            throw new AppError(
              `Insufficient van stock for product ${l.product_id} ` +
              `(wanted ${l.qty}). The order was written offline against stock ` +
              `the van no longer has — most likely an earlier order in the same ` +
              `batch consumed it. Nothing was applied.`,
              409,
              { code: 'INSUFFICIENT_STOCK' }
            );
          }
          if (remaining !== null && remaining <= 5) {
            await repo.enqueueEvent(client, {
              orgId: ctx.orgId, topic: TOPICS.INVENTORY,
              eventType: EVENTS.STOCK_LOW,
              partitionKey: String(l.product_id),
              payload: buildEventPayload(EVENTS.STOCK_LOW, {
                orgId: ctx.orgId,
                productId: l.product_id,
                userId: ctx.userId,
                remaining,
              }),
              traceId: m.trace_id,
            });
          }
        }

        const order = await repo.insertOrder(client, {
          org_id: ctx.orgId,
          visit_id: p.visit_id || null,
          customer_id: p.customer_id,
          created_by: ctx.userId,
          subtotal, discount, total, paid,
          client_ts: m.client_ts,
          last_mutation_id: m.mutation_id,
        });
        await repo.insertOrderLines(client, order.id, priced);

        if (paid > 0) {
          await repo.insertCashEntry(client, {
            org_id: ctx.orgId, user_id: ctx.userId, order_id: order.id,
            amount: paid, kind: 'collect',
            mutation_id: m.mutation_id, client_ts: m.client_ts,
          });
        }

        await repo.enqueueEvent(client, {
          orgId: ctx.orgId, topic: spec.topic, eventType: spec.event,
          partitionKey: String(order.id),
          payload: buildEventPayload(EVENTS.ORDER_CREATED, {
            orgId: ctx.orgId,
            orderId: order.id,
            customerId: p.customer_id,
            total, paid,
            clientTs: m.client_ts,
            syncedAt: now().toISOString(),
            userId: ctx.userId,
            deviceId: ctx.deviceId,
          }),
          traceId: m.trace_id,
        });

        await repo.bumpDeviceSeq(client, ctx.deviceId, m.seq);
        await client.query('RELEASE SAVEPOINT order_create');

        return recordAndReturn(client, ctx, m, {
          outcome: OUTCOME.APPLIED,
          reason: `Order created offline at ${m.client_ts}, synced now. ` +
                  `Stock decremented across ${priced.length} line(s).`,
          entityId: order.id,
          serverVersionAfter: 1,
        });
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT order_create');

        if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') {
          return recordAndReturn(client, ctx, m, {
            outcome: OUTCOME.REJECTED,
            reason: err.message,
            rollback: true,
          });
        }
        throw err;
      }
    });
  }

  async function recordAndReturn(client, ctx, m, r) {
    await repo.recordMutation(client, {
      mutation_id: m.mutation_id,
      org_id: ctx.orgId,
      device_id: ctx.deviceId,
      user_id: ctx.userId,
      seq: m.seq,
      type: m.type,
      entity: SPEC[m.type]?.entity || 'unknown',
      entity_id: r.entityId || m.entity_id || null,
      payload: m.payload,
      base_version: m.base_version ?? null,
      client_ts: m.client_ts,
      outcome: r.outcome,
      resolution: r.resolution || null,
      resolution_reason: r.reason || null,
      server_version_before: r.serverVersionBefore ?? null,
      server_version_after: r.serverVersionAfter ?? null,
      error: r.outcome === OUTCOME.REJECTED ? r.reason : null,
    });

    return {
      mutation_id: m.mutation_id,
      entity_id: r.entityId || m.entity_id || null,
      outcome: r.outcome,
      resolution: r.resolution || null,
      reason: r.reason,
      version: r.serverVersionAfter ?? r.serverVersionBefore ?? null,
      retryable: r.retryable ?? false,
    };
  }

  async function reject(ctx, m, reason) {
    return db.withTransaction((client) =>
      recordAndReturn(client, ctx, m, { outcome: OUTCOME.REJECTED, reason })
    );
  }

  async function pull(ctx, { since }) {
    const at = now();
    const cursor = since ? new Date(new Date(since).getTime() - 1000) : null;

    const changes = await db.withTransaction(async (client) => {
      const data = await repo.pullChanges(client, {
        orgId: ctx.orgId, userId: ctx.userId, since: cursor,
      });
      await repo.setPullCursor(client, ctx.deviceId, at);
      return data;
    });

    return {
      ...changes,
      cursor: at.toISOString(),
      server_time: at.toISOString(),
    };
  }

  return { push, pull, applyOne, SPEC };
}

module.exports = { createSyncService, SPEC };
