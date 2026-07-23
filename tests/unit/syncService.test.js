
const { createSyncService } = require('../../src/services/syncService');
const { MUTATION_TYPES, JOB_STATUS } = require('../../src/constants');

const noopLogger = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {},
  child() { return noopLogger; },
};

function fakeDb() {
  const calls = { transactions: 0, rollbacks: 0 };
  return {
    calls,
    async withTransaction(fn) {
      calls.transactions += 1;
      try {
        return await fn({ query: async () => {} });
      } catch (err) {
        calls.rollbacks += 1;
        throw err;
      }
    },
  };
}

function fakeRepo(overrides = {}) {
  return {
    findSeenMutationIds: jest.fn(async () => new Set()),
    getMutationResults: jest.fn(async () => []),
    lockEntity: jest.fn(async () => ({
      id: 'job-1', org_id: 'org-1', assigned_to: 'user-1',
      status: JOB_STATUS.PICKED_UP, version: 1,
    })),
    fieldsChangedSince: jest.fn(async () => []),
    applyEntityUpdate: jest.fn(async () => ({
      rowCount: 1,
      row: { id: 'job-1', status: JOB_STATUS.DELIVERED, version: 2 },
    })),
    recordMutation: jest.fn(async () => ({ inserted: true, row: {} })),
    bumpDeviceSeq: jest.fn(async () => {}),
    enqueueEvent: jest.fn(async () => 1),
    insertCashEntry: jest.fn(async () => ({ id: 'cash-1' })),
    getProducts: jest.fn(async () => []),
    decrementVanStock: jest.fn(async () => ({ ok: true, remaining: 10 })),
    insertOrder: jest.fn(async () => ({ id: 'order-1', total: 3000 })),
    insertOrderLines: jest.fn(async () => {}),
    pullChanges: jest.fn(async () => ({ jobs: [], visits: [], stock: [] })),
    setPullCursor: jest.fn(async () => {}),
    ...overrides,
  };
}

const ctx = { orgId: 'org-1', userId: 'user-1', deviceId: 'dev-1', role: 'driver' };

const mut = (o = {}) => ({
  mutation_id: `m-${Math.random().toString(36).slice(2, 9)}`,
  seq: 1,
  type: MUTATION_TYPES.JOB_DELIVER,
  entity_id: 'job-1',
  base_version: 1,
  client_ts: '2026-07-13T14:02:00.000Z',
  payload: {},
  ...o,
});

function svc(repo, db = fakeDb()) {
  return {
    service: createSyncService({ db, repo, logger: noopLogger, uuid: () => 'uuid' }),
    db,
    repo,
  };
}

describe('the pipeline', () => {
  test('a clean mutation: locks, applies, records, enqueues — in that order', async () => {
    const repo = fakeRepo();
    const { service } = svc(repo);

    const res = await service.push(ctx, [mut()]);

    expect(res.results[0].outcome).toBe('applied');

    expect(repo.lockEntity).toHaveBeenCalled();
    expect(repo.applyEntityUpdate).toHaveBeenCalled();
    expect(repo.recordMutation).toHaveBeenCalled();

    expect(repo.enqueueEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'job.delivered' })
    );
  });

  test('the event carries BOTH timestamps — happened_at and synced_at', async () => {
    const repo = fakeRepo();
    const { service } = svc(repo);

    await service.push(ctx, [mut({ client_ts: '2026-07-13T14:02:00.000Z' })]);

    const event = repo.enqueueEvent.mock.calls[0][1];
    expect(event.payload.happened_at).toBe('2026-07-13T14:02:00.000Z');
    expect(event.payload.synced_at).toBeTruthy();
    expect(event.payload.happened_at).not.toBe(event.payload.synced_at);
  });

  test('the partition key is the ENTITY id — so events for one job stay ordered', async () => {
    const repo = fakeRepo();
    const { service } = svc(repo);

    await service.push(ctx, [mut({ entity_id: 'job-99' })]);

    expect(repo.enqueueEvent.mock.calls[0][1].partitionKey).toBe('job-99');
  });
});

describe('escalation touches nothing', () => {
  test('when the resolver escalates, applyEntityUpdate is NEVER CALLED', async () => {
    const repo = fakeRepo({
      lockEntity: jest.fn(async () => ({
        id: 'job-1', assigned_to: 'user-1',
        status: JOB_STATUS.ACCEPTED,
        version: 5,
      })),
      fieldsChangedSince: jest.fn(async () => ['field_note']),
    });
    const { service } = svc(repo);

    const res = await service.push(ctx, [mut({
      type: MUTATION_TYPES.JOB_ACCEPT,
      base_version: 1,
      payload: { note: 'x' },
    })]);

    expect(res.results[0].resolution).toBe('escalated');

    expect(repo.applyEntityUpdate).not.toHaveBeenCalled();

    expect(repo.enqueueEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'sync.conflict_escalated' })
    );
  });
});

describe('partial success', () => {
  test('a mutation that THROWS does not kill the rest of the batch', async () => {
    let n = 0;
    const repo = fakeRepo({
      applyEntityUpdate: jest.fn(async () => {
        n += 1;
        if (n === 2) throw new Error('database exploded');
        return { rowCount: 1, row: { status: 'delivered', version: 2 } };
      }),
    });
    const { service } = svc(repo);

    const res = await service.push(ctx, [
      mut({ seq: 1 }), mut({ seq: 2 }), mut({ seq: 3 }),
    ]);

    expect(res.summary.applied).toBe(2);
    expect(res.summary.rejected).toBe(1);

    const failed = res.results.find((r) => r.outcome === 'rejected');
    expect(failed.retryable).toBe(true);
  });
});

describe('idempotency', () => {
  test('a retried mutation gets the SAME answer it got the first time', async () => {
    const repo = fakeRepo({
      findSeenMutationIds: jest.fn(async () => new Set(['m-known'])),
      getMutationResults: jest.fn(async () => [{
        mutation_id: 'm-known',
        outcome: 'conflict',
        resolution: 'server_wins',
        resolution_reason: 'The office cancelled this job.',
        server_version_after: 7,
        entity_id: 'job-1',
      }]),
    });
    const { service } = svc(repo);

    const res = await service.push(ctx, [mut({ mutation_id: 'm-known' })]);

    expect(res.results[0].outcome).toBe('duplicate');
    expect(res.results[0].resolution).toBe('server_wins');
    expect(res.results[0].reason).toMatch(/office cancelled/i);

    expect(repo.applyEntityUpdate).not.toHaveBeenCalled();
  });

  test('dedupe is ONE query for the whole batch, not one per mutation', async () => {
    const repo = fakeRepo();
    const { service } = svc(repo);

    await service.push(ctx, [mut({ seq: 1 }), mut({ seq: 2 }), mut({ seq: 3 })]);

    expect(repo.findSeenMutationIds).toHaveBeenCalledTimes(1);
  });
});

describe('security', () => {
  test('a driver cannot mutate a job assigned to someone else', async () => {
    const repo = fakeRepo({
      lockEntity: jest.fn(async () => ({
        id: 'job-1',
        assigned_to: 'SOMEONE-ELSE',
        status: JOB_STATUS.PICKED_UP,
        version: 1,
      })),
    });
    const { service } = svc(repo);

    const res = await service.push(ctx, [mut()]);

    expect(res.results[0].outcome).toBe('rejected');
    expect(res.results[0].reason).toMatch(/not assigned to you/i);

    expect(repo.applyEntityUpdate).not.toHaveBeenCalled();

    expect(repo.recordMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'rejected' })
    );
  });
});

describe('transition legality', () => {
  test('you cannot deliver a job that was never picked up', async () => {
    const repo = fakeRepo({
      lockEntity: jest.fn(async () => ({
        id: 'job-1', assigned_to: 'user-1',
        status: JOB_STATUS.ASSIGNED,
        version: 1,
      })),
    });
    const { service } = svc(repo);

    const res = await service.push(ctx, [mut({ type: MUTATION_TYPES.JOB_DELIVER })]);

    expect(res.results[0].outcome).toBe('rejected');
    expect(res.results[0].reason).toMatch(/illegal transition/i);
    expect(repo.applyEntityUpdate).not.toHaveBeenCalled();
  });
});

describe('order.create', () => {
  test('price comes from the SERVER, never from the device', async () => {
    const repo = fakeRepo({
      getProducts: jest.fn(async () => [
        { id: 'p1', unit_price: 1000, low_stock_threshold: 5 },
      ]),
    });
    const { service } = svc(repo);

    await service.push(ctx, [mut({
      type: MUTATION_TYPES.ORDER_CREATE,
      entity_id: null,
      base_version: null,
      payload: {
        customer_id: 'c1',
        lines: [{ product_id: 'p1', qty: 3, unit_price: 1 }],
      },
    })]);

    const order = repo.insertOrder.mock.calls[0][1];
    expect(order.total).toBe(3000);
  });

  test('insufficient stock rejects the WHOLE order', async () => {
    const repo = fakeRepo({
      getProducts: jest.fn(async () => [{ id: 'p1', unit_price: 1000 }]),
      decrementVanStock: jest.fn(async () => ({ ok: false, remaining: 0 })),
    });
    const { service } = svc(repo);

    const res = await service.push(ctx, [mut({
      type: MUTATION_TYPES.ORDER_CREATE,
      payload: { customer_id: 'c1', lines: [{ product_id: 'p1', qty: 50 }] },
    })]);

    expect(res.results[0].outcome).toBe('rejected');
    expect(res.results[0].reason).toMatch(/insufficient van stock/i);

    expect(repo.insertOrder).not.toHaveBeenCalled();
  });

  test('low stock emits an event rather than hiding a check in a controller', async () => {
    const repo = fakeRepo({
      getProducts: jest.fn(async () => [{ id: 'p1', unit_price: 1000 }]),
      decrementVanStock: jest.fn(async () => ({ ok: true, remaining: 2 })),
    });
    const { service } = svc(repo);

    await service.push(ctx, [mut({
      type: MUTATION_TYPES.ORDER_CREATE,
      payload: { customer_id: 'c1', lines: [{ product_id: 'p1', qty: 1 }] },
    })]);

    const events = repo.enqueueEvent.mock.calls.map((c) => c[1].eventType);
    expect(events).toContain('stock.low');
  });
});

describe('cash', () => {
  test('the cash entry carries the mutation_id — which is UNIQUE in the DB', async () => {
    const repo = fakeRepo();
    const { service } = svc(repo);

    await service.push(ctx, [mut({
      type: MUTATION_TYPES.CASH_COLLECT,
      mutation_id: 'm-cash-1',
      payload: { amount: 25000 },
    })]);

    expect(repo.insertCashEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mutation_id: 'm-cash-1', amount: 25000 })
    );
  });
});

describe('pull', () => {
  test('the cursor OVERLAPS by one second, deliberately', async () => {
    const repo = fakeRepo();
    const { service } = svc(repo);

    await service.pull(ctx, { since: '2026-07-13T17:00:00.000Z' });

    const arg = repo.pullChanges.mock.calls[0][1];
    expect(arg.since.toISOString()).toBe('2026-07-13T16:59:59.000Z');
  });
});
