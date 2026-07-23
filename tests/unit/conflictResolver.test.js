
const {
  resolve,
  detectConflict,
  isLegalTransition,
  orderMutations,
  partitionByIdempotency,
  RESOLUTION,
  RANK,
  STATE_RANK,
  DEVICE_AUTHORABLE,
} = require('../../src/services/conflictResolver');

const {
  JOB_STATUS,
  JOB_TRANSITIONS,
  RESOLUTION: CONST_RESOLUTION,
} = require('../../src/constants');

describe('constants stay in sync with the resolver', () => {
  test('RESOLUTION enums are identical in both modules', () => {
    expect(RESOLUTION).toEqual(CONST_RESOLUTION);
  });

  test('every job status has a rank', () => {
    for (const status of Object.values(JOB_STATUS)) {
      expect(STATE_RANK[status]).toBeDefined();
    }
  });
});

describe('the Abu Ghraib scenario — a delivery that happened vs a reassignment that did not', () => {
  test('the delivery WINS. The reassignment is superseded.', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'delivered_at', 'recipient_name'],
      deviceTargetStatus: JOB_STATUS.DELIVERED,
      serverStatus: JOB_STATUS.ASSIGNED,
      serverChangedFields: ['assigned_to'],
    });

    expect(decision.resolution).toBe(RESOLUTION.FIELD_WINS);
    expect(decision.winner).toBe('device');
    expect(decision.applyFields).toEqual(['status', 'delivered_at', 'recipient_name']);
    expect(decision.escalate).toBe(false);

    expect(decision.reason).toMatch(/physical truth outranks administrative intent/i);
  });

  test('and a CANCELLATION does not un-deliver a parcel either', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'delivered_at'],
      deviceTargetStatus: JOB_STATUS.DELIVERED,
      serverStatus: JOB_STATUS.CANCELLED,
      serverChangedFields: ['status'],
    });

    expect(decision.resolution).toBe(RESOLUTION.FIELD_WINS);
    expect(decision.winner).toBe('device');
  });

  test('a FAILED delivery is also a physical event and also wins', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'failure_reason'],
      deviceTargetStatus: JOB_STATUS.FAILED,
      serverStatus: JOB_STATUS.ASSIGNED,
      serverChangedFields: ['assigned_to', 'priority'],
    });

    expect(decision.resolution).toBe(RESOLUTION.FIELD_WINS);
  });
});

describe('server wins — when the office decision should stand', () => {
  test('a cancelled job cannot be ACCEPTED by a driver who was offline', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'accepted_at'],
      deviceTargetStatus: JOB_STATUS.ACCEPTED,
      serverStatus: JOB_STATUS.CANCELLED,
      serverChangedFields: ['status'],
    });

    expect(decision.resolution).toBe(RESOLUTION.SERVER_WINS);
    expect(decision.applyFields).toEqual([]);
    expect(decision.escalate).toBe(false);
    expect(decision.reason).toMatch(/intention, not an event/i);
  });

  test('a job already DELIVERED cannot be delivered a second time', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'delivered_at'],
      deviceTargetStatus: JOB_STATUS.DELIVERED,
      serverStatus: JOB_STATUS.DELIVERED,
      serverChangedFields: ['status', 'delivered_at'],
    });

    expect(decision.resolution).toBe(RESOLUTION.SERVER_WINS);
    expect(decision.escalate).toBe(true);
    expect(decision.reason).toMatch(/two devices claim the same parcel/i);
  });

  test('a delivered job is not re-opened by a stale pickup', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'picked_up_at'],
      deviceTargetStatus: JOB_STATUS.PICKED_UP,
      serverStatus: JOB_STATUS.DELIVERED,
      serverChangedFields: ['status'],
    });

    expect(decision.resolution).toBe(RESOLUTION.SERVER_WINS);
    expect(decision.escalate).toBe(false);
  });
});

describe('merge — disjoint fields are not a real conflict', () => {
  test('office changed priority, driver recorded recipient name → BOTH apply', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['recipient_name', 'field_note'],
      deviceTargetStatus: null,
      serverStatus: JOB_STATUS.PICKED_UP,
      serverChangedFields: ['priority'],
    });

    expect(decision.resolution).toBe(RESOLUTION.MERGED);
    expect(decision.winner).toBe('both');
    expect(decision.applyFields).toEqual(['recipient_name', 'field_note']);
    expect(decision.reason).toMatch(/never a real disagreement/i);
  });

  test('office rescheduled the window, driver attached proof → BOTH apply', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['proof_media_key'],
      deviceTargetStatus: null,
      serverStatus: JOB_STATUS.PICKED_UP,
      serverChangedFields: ['window_start', 'window_end'],
    });

    expect(decision.resolution).toBe(RESOLUTION.MERGED);
  });

  test('version/updated_at churn alone is NOT a conflict', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['field_note'],
      deviceTargetStatus: null,
      serverStatus: JOB_STATUS.ACCEPTED,
      serverChangedFields: ['version', 'updated_at'],
    });

    expect(decision.resolution).toBe(RESOLUTION.MERGED);
  });

  test('but OVERLAPPING fields are a real conflict, not a merge', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['field_note'],
      deviceTargetStatus: null,
      serverStatus: JOB_STATUS.ACCEPTED,
      serverChangedFields: ['field_note'],
    });

    expect(decision.resolution).not.toBe(RESOLUTION.MERGED);
  });
});

describe('escalation — when there is no principled winner', () => {
  test('equal rank + overlapping fields → hand it to a human', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['field_note'],
      deviceTargetStatus: JOB_STATUS.ACCEPTED,
      serverStatus: JOB_STATUS.ACCEPTED,
      serverChangedFields: ['field_note'],
    });

    expect(decision.resolution).toBe(RESOLUTION.ESCALATED);
    expect(decision.escalate).toBe(true);
    expect(decision.applyFields).toEqual([]);
    expect(decision.reason).toMatch(/refuses to invent one/i);
  });

  test('escalation never silently writes', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['field_note'],
      deviceTargetStatus: JOB_STATUS.ACCEPTED,
      serverStatus: JOB_STATUS.ACCEPTED,
      serverChangedFields: ['field_note'],
    });
    expect(decision.applyFields).toHaveLength(0);
  });
});

describe('security — a device may only author device-owned fields', () => {
  test.each([
    ['price', 'a driver setting his own delivery price'],
    ['assigned_to', 'a driver assigning the job to himself'],
    ['customer_id', 'a driver changing who the customer is'],
    ['cod_amount', 'a driver reducing the cash he owes'],
  ])('REJECTS a device trying to write "%s" (%s)', (field) => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', field],
      deviceTargetStatus: JOB_STATUS.DELIVERED,
      serverStatus: JOB_STATUS.PICKED_UP,
      serverChangedFields: [],
    });

    expect(decision.resolution).toBe(RESOLUTION.SERVER_WINS);
    expect(decision.applyFields).toEqual([]);
    expect(decision.reason).toMatch(/mass-assignment/i);
  });

  test('the rejection beats even the field-wins rule', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'delivered_at', 'price'],
      deviceTargetStatus: JOB_STATUS.DELIVERED,
      serverStatus: JOB_STATUS.ASSIGNED,
      serverChangedFields: ['assigned_to'],
    });

    expect(decision.resolution).toBe(RESOLUTION.SERVER_WINS);
    expect(decision.applyFields).toEqual([]);
  });

  test('the allowlist itself does not contain anything financial or assignment-related', () => {
    const forbidden = ['price', 'cod_amount', 'assigned_to', 'customer_id', 'org_id', 'version'];
    for (const f of forbidden) {
      expect(DEVICE_AUTHORABLE.job.has(f)).toBe(false);
    }
  });

  test('all legitimate device fields ARE allowed', () => {
    const decision = resolve({
      entity: 'job',
      deviceFields: ['status', 'delivered_at', 'recipient_name', 'proof_media_key',
                     'delivered_lat', 'delivered_lng', 'field_note'],
      deviceTargetStatus: JOB_STATUS.DELIVERED,
      serverStatus: JOB_STATUS.PICKED_UP,
      serverChangedFields: [],
    });
    expect(decision.resolution).not.toBe(RESOLUTION.SERVER_WINS);
  });
});

describe('detectConflict — optimistic concurrency', () => {
  test('same version → no conflict', () => {
    expect(detectConflict({ baseVersion: 3, serverVersion: 3 })).toBe(false);
  });

  test('server moved ahead → conflict', () => {
    expect(detectConflict({ baseVersion: 3, serverVersion: 5 })).toBe(true);
  });

  test('null base version (a CREATE) → never a conflict', () => {
    expect(detectConflict({ baseVersion: null, serverVersion: 1 })).toBe(false);
    expect(detectConflict({ baseVersion: undefined, serverVersion: 1 })).toBe(false);
  });

  test('string vs number version → still compared correctly', () => {
    expect(detectConflict({ baseVersion: '3', serverVersion: 3 })).toBe(false);
    expect(detectConflict({ baseVersion: 3, serverVersion: '4' })).toBe(true);
  });

  test('version 0 is a real version, not a falsy nothing', () => {
    expect(detectConflict({ baseVersion: 0, serverVersion: 0 })).toBe(false);
    expect(detectConflict({ baseVersion: 0, serverVersion: 1 })).toBe(true);
  });
});

describe('isLegalTransition', () => {
  test('the happy path is legal', () => {
    expect(isLegalTransition(JOB_TRANSITIONS, JOB_STATUS.ASSIGNED, JOB_STATUS.ACCEPTED)).toBe(true);
    expect(isLegalTransition(JOB_TRANSITIONS, JOB_STATUS.ACCEPTED, JOB_STATUS.PICKED_UP)).toBe(true);
    expect(isLegalTransition(JOB_TRANSITIONS, JOB_STATUS.PICKED_UP, JOB_STATUS.DELIVERED)).toBe(true);
  });

  test('you cannot deliver something you never picked up', () => {
    expect(isLegalTransition(JOB_TRANSITIONS, JOB_STATUS.ASSIGNED, JOB_STATUS.DELIVERED)).toBe(false);
  });

  test('terminal states are terminal — nothing leaves them', () => {
    for (const terminal of [JOB_STATUS.DELIVERED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]) {
      for (const to of Object.values(JOB_STATUS)) {
        expect(isLegalTransition(JOB_TRANSITIONS, terminal, to)).toBe(false);
      }
    }
  });

  test('an unknown state is not a crash, it is a "no"', () => {
    expect(isLegalTransition(JOB_TRANSITIONS, 'banana', JOB_STATUS.DELIVERED)).toBe(false);
  });

  test('reassignment (assigned → assigned) is legal — the office does this', () => {
    expect(isLegalTransition(JOB_TRANSITIONS, JOB_STATUS.ASSIGNED, JOB_STATUS.ASSIGNED)).toBe(true);
  });
});

describe('orderMutations', () => {
  test('within a device, seq is the truth — arrival order is ignored', () => {
    const shuffled = [
      { device_id: 'd1', seq: 3, mutation_id: 'c', client_ts: '2026-07-13T14:02:00Z' },
      { device_id: 'd1', seq: 1, mutation_id: 'a', client_ts: '2026-07-13T13:00:00Z' },
      { device_id: 'd1', seq: 2, mutation_id: 'b', client_ts: '2026-07-13T13:30:00Z' },
    ];
    expect(orderMutations(shuffled).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  test('a lying clock does NOT reorder a single device', () => {
    const clockIsWrong = [
      { device_id: 'd1', seq: 1, mutation_id: 'a', client_ts: '2026-07-13T23:00:00Z' },
      { device_id: 'd1', seq: 2, mutation_id: 'b', client_ts: '2026-07-13T01:00:00Z' },
    ];
    expect(orderMutations(clockIsWrong).map((m) => m.seq)).toEqual([1, 2]);
  });

  test('across devices, fall back to client_ts', () => {
    const two = [
      { device_id: 'd2', seq: 1, mutation_id: 'b', client_ts: '2026-07-13T15:00:00Z' },
      { device_id: 'd1', seq: 1, mutation_id: 'a', client_ts: '2026-07-13T14:00:00Z' },
    ];
    expect(orderMutations(two).map((m) => m.mutation_id)).toEqual(['a', 'b']);
  });

  test('identical timestamps break the tie DETERMINISTICALLY', () => {
    const tied = [
      { device_id: 'd2', seq: 1, mutation_id: 'zzz', client_ts: '2026-07-13T14:00:00Z' },
      { device_id: 'd1', seq: 1, mutation_id: 'aaa', client_ts: '2026-07-13T14:00:00Z' },
    ];
    const once = orderMutations(tied).map((m) => m.mutation_id);
    const twice = orderMutations([...tied].reverse()).map((m) => m.mutation_id);
    expect(once).toEqual(twice);
    expect(once).toEqual(['aaa', 'zzz']);
  });

  test('does not mutate its input', () => {
    const input = [
      { device_id: 'd1', seq: 2, mutation_id: 'b', client_ts: '2026-07-13T14:00:00Z' },
      { device_id: 'd1', seq: 1, mutation_id: 'a', client_ts: '2026-07-13T13:00:00Z' },
    ];
    const before = JSON.stringify(input);
    orderMutations(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('an empty batch is fine', () => {
    expect(orderMutations([])).toEqual([]);
  });
});

describe('partitionByIdempotency', () => {
  const m = (id) => ({ mutation_id: id, seq: 1, device_id: 'd1' });

  test('splits fresh from already-seen', () => {
    const batch = [m('a'), m('b'), m('c')];
    const { fresh, duplicates } = partitionByIdempotency(batch, new Set(['b']));
    expect(fresh.map((x) => x.mutation_id)).toEqual(['a', 'c']);
    expect(duplicates.map((x) => x.mutation_id)).toEqual(['b']);
  });

  test('catches a duplicate WITHIN a single batch', () => {
    const batch = [m('a'), m('a'), m('b')];
    const { fresh, duplicates } = partitionByIdempotency(batch, new Set());
    expect(fresh).toHaveLength(2);
    expect(duplicates).toHaveLength(1);
  });

  test('a fully-duplicate batch (the classic lost-ACK retry) applies NOTHING', () => {
    const batch = [m('a'), m('b')];
    const { fresh, duplicates } = partitionByIdempotency(batch, new Set(['a', 'b']));
    expect(fresh).toEqual([]);
    expect(duplicates).toHaveLength(2);
  });

  test('preserves order within each partition', () => {
    const batch = [m('a'), m('b'), m('c'), m('d')];
    const { fresh } = partitionByIdempotency(batch, new Set(['b']));
    expect(fresh.map((x) => x.mutation_id)).toEqual(['a', 'c', 'd']);
  });

  test('empty batch, empty seen set', () => {
    const { fresh, duplicates } = partitionByIdempotency([], new Set());
    expect(fresh).toEqual([]);
    expect(duplicates).toEqual([]);
  });
});

describe('the rank doctrine', () => {
  test('physical > admin > progress > initial', () => {
    expect(RANK.PHYSICAL).toBeGreaterThan(RANK.ADMIN);
    expect(RANK.ADMIN).toBeGreaterThan(RANK.PROGRESS);
    expect(RANK.PROGRESS).toBeGreaterThan(RANK.INITIAL);
  });

  test('delivered and failed are PHYSICAL; cancelled is merely ADMIN', () => {
    expect(STATE_RANK[JOB_STATUS.DELIVERED]).toBe(RANK.PHYSICAL);
    expect(STATE_RANK[JOB_STATUS.FAILED]).toBe(RANK.PHYSICAL);
    expect(STATE_RANK[JOB_STATUS.CANCELLED]).toBe(RANK.ADMIN);
  });

  test('every in-flight state is PROGRESS and loses to any terminal', () => {
    for (const s of [JOB_STATUS.ASSIGNED, JOB_STATUS.ACCEPTED, JOB_STATUS.PICKED_UP]) {
      expect(STATE_RANK[s]).toBe(RANK.PROGRESS);
      expect(STATE_RANK[s]).toBeLessThan(STATE_RANK[JOB_STATUS.DELIVERED]);
      expect(STATE_RANK[s]).toBeLessThan(STATE_RANK[JOB_STATUS.CANCELLED]);
    }
  });
});

describe('field-sales visits use the identical rules', () => {
  test('a completed visit beats an office reassignment', () => {
    const decision = resolve({
      entity: 'visit',
      deviceFields: ['status', 'completed_at'],
      deviceTargetStatus: 'completed',
      serverStatus: 'planned',
      serverChangedFields: ['assigned_to'],
    });
    expect(decision.resolution).toBe(RESOLUTION.FIELD_WINS);
  });

  test('a skipped visit (shop was shut) is also physical', () => {
    const decision = resolve({
      entity: 'visit',
      deviceFields: ['status', 'skip_reason'],
      deviceTargetStatus: 'skipped',
      serverStatus: 'planned',
      serverChangedFields: ['planned_for'],
    });
    expect(decision.resolution).toBe(RESOLUTION.FIELD_WINS);
  });

  test('a salesman cannot author route_id either', () => {
    const decision = resolve({
      entity: 'visit',
      deviceFields: ['status', 'route_id'],
      deviceTargetStatus: 'completed',
      serverStatus: 'planned',
      serverChangedFields: [],
    });
    expect(decision.reason).toMatch(/mass-assignment/i);
  });
});
