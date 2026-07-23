

const OUTCOME = Object.freeze({
  APPLIED: 'applied',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  REJECTED: 'rejected',
});

const RESOLUTION = Object.freeze({
  FIELD_WINS: 'field_wins',
  SERVER_WINS: 'server_wins',
  MERGED: 'merged',
  ESCALATED: 'escalated',
});

const RANK = Object.freeze({ INITIAL: 0, PROGRESS: 1, ADMIN: 2, PHYSICAL: 3 });

const STATE_RANK = Object.freeze({
  draft: RANK.INITIAL,
  assigned: RANK.PROGRESS,
  accepted: RANK.PROGRESS,
  picked_up: RANK.PROGRESS,
  delivered: RANK.PHYSICAL,
  failed: RANK.PHYSICAL,
  cancelled: RANK.ADMIN,

  planned: RANK.INITIAL,
  checked_in: RANK.PROGRESS,
  completed: RANK.PHYSICAL,
  skipped: RANK.PHYSICAL,
});

const DEVICE_AUTHORABLE = Object.freeze({
  job: new Set([
    'status',
    'accepted_at',
    'picked_up_at',
    'delivered_at',
    'failure_reason',
    'cash_collected',
    'proof_media_key',
    'recipient_name',
    'field_note',
    'delivered_lat',
    'delivered_lng',
  ]),
  visit: new Set([
    'status',
    'checked_in_at',
    'completed_at',
    'skip_reason',
    'field_note',
    'checkin_lat',
    'checkin_lng',
  ]),
});

const SERVER_AUTHORABLE = Object.freeze({
  job: new Set(['assigned_to', 'priority', 'customer_id', 'address', 'window_start', 'window_end', 'price']),
  visit: new Set(['assigned_to', 'planned_for', 'customer_id', 'route_id']),
});

function isLegalTransition(transitions, from, to) {
  const allowed = transitions[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

function detectConflict({ baseVersion, serverVersion }) {
  if (baseVersion === null || baseVersion === undefined) return false;
  return Number(baseVersion) !== Number(serverVersion);
}

function resolve({
  entity,
  deviceFields,
  deviceTargetStatus,
  serverStatus,
  serverChangedFields,
}) {
  const deviceAuthorable = DEVICE_AUTHORABLE[entity];
  const serverAuthorable = SERVER_AUTHORABLE[entity];

  const illegal = deviceFields.filter((f) => !deviceAuthorable.has(f));
  if (illegal.length > 0) {
    return {
      resolution: RESOLUTION.SERVER_WINS,
      winner: 'server',
      applyFields: [],
      escalate: false,
      reason: `Device attempted to author non-device fields: ${illegal.join(', ')}. ` +
              `Rejected outright — this is a mass-assignment attempt, not a conflict.`,
    };
  }

  const serverRank = STATE_RANK[serverStatus] ?? RANK.INITIAL;
  const deviceRank = deviceTargetStatus ? (STATE_RANK[deviceTargetStatus] ?? RANK.PROGRESS) : RANK.PROGRESS;

  const deviceIsPhysicalClaim =
    deviceTargetStatus && (STATE_RANK[deviceTargetStatus] ?? RANK.PROGRESS) === RANK.PHYSICAL;

  const overlap = deviceFields.filter((f) => serverChangedFields.includes(f));
  const serverOnlyTouchedItsOwn = serverChangedFields.every(
    (f) => serverAuthorable.has(f) || f === 'version' || f === 'updated_at'
  );

  if (!deviceIsPhysicalClaim && overlap.length === 0 && serverOnlyTouchedItsOwn) {
    return {
      resolution: RESOLUTION.MERGED,
      winner: 'both',
      applyFields: deviceFields,
      escalate: false,
      reason:
        'No overlapping fields. The office changed office-owned fields ' +
        `(${serverChangedFields.join(', ') || 'none'}) while the device changed ` +
        `device-owned fields (${deviceFields.join(', ')}). Both applied — there was ` +
        'never a real disagreement, only a stale version number.',
    };
  }

  if (serverRank === RANK.PHYSICAL) {
    return {
      resolution: RESOLUTION.SERVER_WINS,
      winner: 'server',
      applyFields: [],
      escalate: deviceRank === RANK.PHYSICAL,
      reason:
        `Server already holds a physical terminal state (${serverStatus}). A physical ` +
        'event cannot be superseded by a later write. ' +
        (deviceRank === RANK.PHYSICAL
          ? 'The device ALSO reports a physical event — two devices claim the same ' +
            'parcel. Escalated: this is a real-world discrepancy, not a data one.'
          : 'Device mutation discarded.'),
    };
  }

  if (deviceRank === RANK.PHYSICAL) {
    return {
      resolution: RESOLUTION.FIELD_WINS,
      winner: 'device',
      applyFields: deviceFields,
      escalate: false,
      reason:
        `Device reports a physical event (${deviceTargetStatus}) recorded in the field. ` +
        `The server row was at "${serverStatus}"` +
        (serverChangedFields.length
          ? ` and the office had changed [${serverChangedFields.join(', ')}].`
          : '.') +
        ' Physical truth outranks administrative intent: the parcel is in the ' +
        "customer's hands and no office edit can un-happen that. Field write applied; " +
        'the office change is superseded and the dispatcher is notified.',
    };
  }

  if (serverRank === RANK.ADMIN && deviceRank === RANK.PROGRESS) {
    return {
      resolution: RESOLUTION.SERVER_WINS,
      winner: 'server',
      applyFields: [],
      escalate: false,
      reason:
        `Job was ${serverStatus} by the office. The device is attempting a progress ` +
        `transition (${deviceTargetStatus}) — an intention, not an event. Nothing ` +
        'physical is being denied. Office decision stands; the device is told the job ' +
        'is dead so it stops working it.',
    };
  }

  if (deviceRank > serverRank) {
    return {
      resolution: RESOLUTION.FIELD_WINS,
      winner: 'device',
      applyFields: deviceFields,
      escalate: false,
      reason:
        `Device state (${deviceTargetStatus}, rank ${deviceRank}) is further along than ` +
        `server state (${serverStatus}, rank ${serverRank}). The field is ahead of the ` +
        'office — which is the normal case for an offline device. Applied.',
    };
  }

  if (serverRank > deviceRank) {
    return {
      resolution: RESOLUTION.SERVER_WINS,
      winner: 'server',
      applyFields: [],
      escalate: false,
      reason:
        `Server state (${serverStatus}, rank ${serverRank}) outranks the device's ` +
        `(${deviceTargetStatus}, rank ${deviceRank}). Device write discarded as stale.`,
    };
  }

  return {
    resolution: RESOLUTION.ESCALATED,
    winner: 'server',
    applyFields: [],
    escalate: true,
    reason:
      `Equal rank (${deviceRank}) with overlapping fields [${overlap.join(', ')}]. ` +
      'There is no principled winner here, so the system refuses to invent one. ' +
      'Escalated to a dispatcher with both versions attached. Guessing silently is ' +
      'how systems lose money quietly.',
  };
}

function orderMutations(mutations) {
  return [...mutations].sort((a, b) => {
    if (a.device_id === b.device_id) return a.seq - b.seq;
    const ta = new Date(a.client_ts).getTime();
    const tb = new Date(b.client_ts).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.mutation_id).localeCompare(String(b.mutation_id));
  });
}

function partitionByIdempotency(mutations, seenIds) {
  const fresh = [];
  const duplicates = [];
  const withinBatch = new Set();

  for (const m of mutations) {
    if (seenIds.has(m.mutation_id) || withinBatch.has(m.mutation_id)) {
      duplicates.push(m);
    } else {
      withinBatch.add(m.mutation_id);
      fresh.push(m);
    }
  }
  return { fresh, duplicates };
}

module.exports = {
  OUTCOME,
  RESOLUTION,
  RANK,
  STATE_RANK,
  DEVICE_AUTHORABLE,
  SERVER_AUTHORABLE,
  isLegalTransition,
  detectConflict,
  resolve,
  orderMutations,
  partitionByIdempotency,
};
