

const DataLoader = require('dataloader');

function createLoaders(db, orgId) {
  return {
    driverById: new DataLoader(async (ids) => {
      const { rows } = await db.query(
        `SELECT id, name, role FROM users WHERE org_id = $1 AND id = ANY($2)`,
        [orgId, ids]
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id) || null);
    }),

    customerById: new DataLoader(async (ids) => {
      const { rows } = await db.query(
        `SELECT id, name, phone, address FROM customers WHERE org_id = $1 AND id = ANY($2)`,
        [orgId, ids]
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id) || null);
    }),

    cashByDriver: new DataLoader(async (driverIds) => {
      const { rows } = await db.query(
        `SELECT user_id,
                COALESCE(SUM(CASE WHEN kind='collect' THEN amount
                                  WHEN kind='remit'   THEN -amount ELSE 0 END),0)::int AS outstanding
           FROM cash_entries
          WHERE org_id = $1 AND user_id = ANY($2)
          GROUP BY user_id`,
        [orgId, driverIds]
      );
      const byId = new Map(rows.map((r) => [r.user_id, r.outstanding]));
      return driverIds.map((id) => byId.get(id) || 0);
    }),

    darkByDevice: new DataLoader(async (userIds) => {
      const { rows } = await db.query(
        `SELECT user_id,
                EXTRACT(EPOCH FROM (now() - MAX(last_seen_at)))::int AS dark
           FROM devices WHERE org_id = $1 AND user_id = ANY($2)
          GROUP BY user_id`,
        [orgId, userIds]
      );
      const byId = new Map(rows.map((r) => [r.user_id, r.dark]));
      return userIds.map((id) => byId.get(id) ?? null);
    }),
  };
}

const health = (dark) =>
  dark == null ? 'never_synced'
  : dark < 300 ? 'online'
  : dark < 3600 ? 'dark'
  : 'long_dark';

const resolvers = {
  Query: {
    async jobs(_, { status, assignedTo, search, limit }, ctx) {
      const items = await ctx.repos.jobRepo.listForOrg(ctx.orgId, {
        status, assignedTo, q: search, limit,
      });
      return { items: items.items, total: items.total };
    },

    async job(_, { id }, ctx) {
      return ctx.repos.jobRepo.findById(ctx.orgId, id);
    },

    async drivers(_, __, ctx) {
      return ctx.repos.deviceRepo.listWithHealth(ctx.orgId)
        .then((rows) => {
          const seen = new Map();
          for (const r of rows) {
            if (!seen.has(r.user_id)) {
              seen.set(r.user_id, {
                id: r.user_id, name: r.user_name, role: r.role,
                darkSeconds: r.dark_seconds,
              });
            }
          }
          return [...seen.values()];
        });
    },

    async escalations(_, __, ctx) {
      const rows = await ctx.repos.jobRepo.listEscalations(ctx.orgId, {});
      return rows.map((r) => ({
        mutationId: r.mutation_id,
        jobRef: r.ref,
        reason: r.resolution_reason,
        driverName: r.driver_name,
        darkSeconds: r.dark_seconds,
        receivedAt: r.received_at,
      }));
    },

    async darkTimeReport(_, { from, to }, ctx) {
      const rows = await ctx.repos.reportRepo.darkTime(ctx.orgId, {
        from: from || new Date(Date.now() - 30 * 864e5).toISOString(),
        to: to || new Date().toISOString(),
      });
      return rows.map((r) => ({
        driverId: r.id, driverName: r.name, mutations: r.mutations,
        p50DarkSeconds: r.p50_dark_seconds,
        p95DarkSeconds: r.p95_dark_seconds,
        worstDarkSeconds: r.worst_dark_seconds,
      }));
    },
  },

  Job: {
    codAmount: (j) => j.cod_amount,
    createdAt: (j) => j.created_at,
    updatedAt: (j) => j.updated_at,

    customer: (j, _, ctx) => j.customer_id ? ctx.loaders.customerById.load(j.customer_id) : null,
    driver: (j, _, ctx) => j.assigned_to ? ctx.loaders.driverById.load(j.assigned_to) : null,

    async history(j, _, ctx) {
      const rows = await ctx.repos.jobRepo.history(ctx.orgId, j.id);
      return rows.map((r) => ({
        id: r.mutation_id,
        type: r.type,
        outcome: r.outcome,
        resolution: r.resolution,
        resolutionReason: r.resolution_reason,
        happenedAt: r.client_ts,
        receivedAt: r.received_at,
        darkSeconds: r.dark_seconds,
        _actorId: r.user_id,
        deviceLabel: r.device_label,
      }));
    },
  },

  Driver: {
    darkSeconds: (d, _, ctx) =>
      d.darkSeconds !== undefined ? d.darkSeconds : ctx.loaders.darkByDevice.load(d.id),
    health: (d) => health(d.darkSeconds),
    cashOutstanding: (d, _, ctx) => ctx.loaders.cashByDriver.load(d.id),
  },

  Mutation: {
    actor: (m, _, ctx) => m._actorId ? ctx.loaders.driverById.load(m._actorId) : null,
  },
};

module.exports = { resolvers, createLoaders };
