const express = require('express');
const { randomUUID } = require('crypto');
const catchAsync = require('../utils/catchAsync');
const { sendOk } = require('../utils/response');

function createDemoController({ db, syncService, jobRepo, seedDemo, logger }) {
  const router = express.Router();

  router.post('/session', catchAsync(async (req, res) => {
    const session = await seedDemo();

    logger.info({ orgId: session.orgId }, 'demo: session created');

    return sendOk(res, {
      session_id: session.orgId,
      expires_in: 3600,
      driver: {
        device_token: session.deviceToken,
        device_id: session.deviceId,
        user: session.driver,
      },
      dispatcher: {
        access_token: session.dispatcherToken,
        user: session.dispatcher,
      },
      jobs: session.jobs,
      scripted_scenario: {
        title: 'The Abu Ghraib conflict',
        steps: [
          'Toggle OFFLINE on the driver panel.',
          `As the driver: mark job ${session.jobs[0].ref} PICKED UP, then DELIVERED. Note the UI updates instantly — those writes went to a local queue, not to us.`,
          `As the dispatcher (still online): REASSIGN job ${session.jobs[0].ref} to the other driver. The office thinks the first driver is stuck.`,
          'Toggle RECONNECT. Watch the sync.',
          'The delivery WINS. Read the reason the server gives.',
          'Open PEEK BEHIND THE CURTAIN to see the events, the trace, and the ledger.',
        ],
      },
    }, 'Demo session ready. It self-destructs in one hour.');
  }));

  router.post('/scenario/conflict', catchAsync(async (req, res) => {
    const session = await seedDemo();
    const job = session.jobs[0];
    const transcript = [];

    const at = (t) => new Date(Date.UTC(2026, 6, 13, ...t)).toISOString();

    transcript.push({
      t: at([13, 40]),
      actor: 'driver',
      event: 'LOST SIGNAL',
      note: 'The phone is now working entirely from local storage. Nothing reaches us.',
    });

    const deliverMutation = {
      mutation_id: randomUUID(),
      seq: 1,
      type: 'job.deliver',
      entity_id: job.id,
      base_version: job.version,
      client_ts: at([14, 2]),
      payload: { recipient_name: 'Um Ahmed', note: 'Handed over at the gate.' },
    };
    transcript.push({
      t: at([14, 2]),
      actor: 'driver',
      event: 'DELIVERED (offline)',
      note: 'Parcel is in the customer\'s hands. Queued locally. The server knows nothing.',
      mutation: deliverMutation,
    });

    await db.withTransaction(async (client) => {
      await jobRepo.officeUpdate(client, {
        orgId: session.orgId,
        id: job.id,
        fields: { assigned_to: session.otherDriverId, status: 'assigned' },
        actorId: session.dispatcher.id,
        expectedVersion: job.version,
      });
    });
    transcript.push({
      t: at([14, 30]),
      actor: 'dispatcher',
      event: 'REASSIGNED to another driver',
      note: 'The office assumes the first driver is stuck. This is a REASONABLE decision '
          + 'given what the office can see — and it is about to turn out to be wrong.',
    });

    const result = await syncService.push(
      {
        orgId: session.orgId,
        userId: session.driver.id,
        deviceId: session.deviceId,
        role: 'driver',
      },
      [deliverMutation]
    );

    const verdict = result.results[0];

    transcript.push({
      t: at([17, 0]),
      actor: 'system',
      event: 'SYNC — the delivery arrives 2h 58m after it happened',
      note: 'The row has moved underneath the device (version 1 → 2). Conflict detected.',
    });

    transcript.push({
      t: at([17, 0]),
      actor: 'system',
      event: `RESOLVED — ${verdict.resolution?.toUpperCase()}`,
      note: verdict.reason,
      verdict,
    });

    const timeline = await jobRepo.history(session.orgId, job.id);
    const after = await jobRepo.findById(session.orgId, job.id);

    return sendOk(res, {
      transcript,
      outcome: {
        resolution: verdict.resolution,
        job_status_now: after.status,
        assigned_to_now: after.assigned_to,
        plain_english:
          verdict.resolution === 'field_wins'
            ? 'The delivery stands. The parcel is with the customer, and no office '
              + 'edit made three hours later can un-happen that. The dispatcher is '
              + 'notified that their reassignment was superseded by reality.'
            : `Resolved as ${verdict.resolution}.`,
      },
      ledger: timeline,
      behind_the_curtain: {
        mutation_ledger: timeline,
        note: 'Every row above is a real row in Postgres, written by the real sync '
            + 'engine in a real transaction. Nothing here is simulated.',
      },
    }, 'Scenario complete.');
  }));

  router.get('/curtain/:orgId', catchAsync(async (req, res) => {
    const orgId = req.params.orgId;

    const [mutations, outbox, conflicts, jobs] = await Promise.all([
      db.query(
        `SELECT mutation_id, type, outcome, resolution, resolution_reason,
                client_ts, received_at,
                EXTRACT(EPOCH FROM (received_at - client_ts))::int AS dark_seconds,
                server_version_before, server_version_after
           FROM mutations WHERE org_id = $1 ORDER BY received_at DESC LIMIT 50`,
        [orgId]
      ),
      db.query(
        `SELECT id, topic, event_type, status, attempts, partition_key,
                created_at, published_at
           FROM outbox WHERE org_id = $1 ORDER BY id DESC LIMIT 50`,
        [orgId]
      ),
      db.query(
        `SELECT COALESCE(resolution,'clean') AS resolution, count(*)::int AS n
           FROM mutations WHERE org_id = $1 GROUP BY resolution`,
        [orgId]
      ),
      db.query(`SELECT id, ref, status, version, assigned_to FROM jobs WHERE org_id = $1`, [orgId]),
    ]);

    return sendOk(res, {
      mutation_ledger: {
        rows: mutations.rows,
        explain:
          'Append-only. This is the idempotency store, the audit trail, and the replay '
          + 'log, all at once. `dark_seconds` is the gap between when the driver ACTED '
          + 'and when we HEARD — the number a normal API throws away.',
      },
      outbox: {
        rows: outbox.rows,
        pending: outbox.rows.filter((r) => r.status === 'pending').length,
        published: outbox.rows.filter((r) => r.status === 'published').length,
        explain:
          'Each of these was written in the SAME Postgres transaction as the state '
          + 'change that produced it. That is the whole point: the event and the state '
          + 'commit together, or neither does. A separate worker drains them to Kafka. '
          + 'Watch a row flip from pending → published as the publisher picks it up.',
      },
      conflict_summary: {
        rows: conflicts.rows,
        explain:
          'field_wins = a physical event beat an office edit. server_wins = the office '
          + 'was right. merged = they never actually disagreed. escalated = the system '
          + 'refused to guess and asked a human.',
      },
      jobs: jobs.rows,
      version_explain:
        'Every job carries an integer `version`. A device echoes back the version it '
        + 'last saw. If they differ, somebody changed the row while the device was dark. '
        + 'That one integer comparison IS the entire conflict-detection mechanism.',
    });
  }));

  router.post('/queue/flush', catchAsync(async (req, res) => {
    const { session_id, device_id, user_id, mutations } = req.body;

    const result = await syncService.push(
      { orgId: session_id, userId: user_id, deviceId: device_id, role: 'driver' },
      mutations
    );

    return sendOk(res, {
      ...result,
      narration: result.results.map((r) => ({
        mutation_id: r.mutation_id,
        outcome: r.outcome,
        why: r.reason,
      })),
    }, 'Queue flushed.');
  }));

  return { router };
}

module.exports = { createDemoController };
