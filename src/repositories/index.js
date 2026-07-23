const { query, withTransaction } = require('../db/pool');

const userRepo = {
  async findById(orgId, id) {
    const { rows } = await query(
      `SELECT u.*, o.locale
         FROM users u JOIN orgs o ON o.id = u.org_id
        WHERE u.id = $1 AND u.org_id = $2`,
      [id, orgId]
    );
    return rows[0] || null;
  },

  async findByPhone(orgSlug, phone) {
    const { rows } = await query(
      `SELECT u.*, o.locale
         FROM users u JOIN orgs o ON o.id = u.org_id
        WHERE o.slug = $1 AND u.phone = $2`,
      [orgSlug, phone]
    );
    return rows[0] || null;
  },

  async create(c, u) {
    const { rows } = await c.query(
      `INSERT INTO users (org_id, name, phone, password_hash, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [u.org_id, u.name, u.phone, u.password_hash, u.role]
    );
    return rows[0];
  },

  async bumpTokenVersion(orgId, userId) {
    await query(
      `UPDATE users SET token_version = token_version + 1
        WHERE id = $1 AND org_id = $2`,
      [userId, orgId]
    );
  },

  async listByRole(orgId, role) {
    const { rows } = await query(
      `SELECT id, name, phone, role, active FROM users
        WHERE org_id = $1 AND role = $2 AND active = true ORDER BY name`,
      [orgId, role]
    );
    return rows;
  },
};

const deviceRepo = {
  async findById(id) {
    const { rows } = await query(`SELECT * FROM devices WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  async create(d) {
    const { rows } = await query(
      `INSERT INTO devices (org_id, user_id, label, platform)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [d.org_id, d.user_id, d.label || null, d.platform || null]
    );
    return rows[0];
  },

  async revoke(orgId, deviceId) {
    await query(
      `UPDATE devices SET revoked = true WHERE id = $1 AND org_id = $2`,
      [deviceId, orgId]
    );
  },

  async listWithHealth(orgId) {
    const { rows } = await query(
      `SELECT d.id, d.label, d.platform, d.revoked, d.last_seen_at,
              d.last_applied_seq,
              u.id AS user_id, u.name AS user_name, u.role,
              EXTRACT(EPOCH FROM (now() - d.last_seen_at))::int AS dark_seconds
         FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.org_id = $1
        ORDER BY d.last_seen_at DESC NULLS LAST`,
      [orgId]
    );
    return rows;
  },
};

const jobRepo = {
  async findById(orgId, id) {
    const { rows } = await query(
      `SELECT * FROM jobs WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    return rows[0] || null;
  },

  async listForDriver(orgId, userId, { status, page = 1, limit = 50 }) {
    const offset = (page - 1) * limit;
    const params = [orgId, userId, limit, offset];
    let statusClause = '';
    if (status) {
      params.push(status);
      statusClause = `AND status = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
         FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
        WHERE j.org_id = $1 AND j.assigned_to = $2 ${statusClause}
        ORDER BY j.priority DESC, j.window_start ASC NULLS LAST
        LIMIT $3 OFFSET $4`,
      params
    );

    const countParams = status ? [orgId, userId, status] : [orgId, userId];
    const { rows: cnt } = await query(
      `SELECT count(*)::int AS total FROM jobs
        WHERE org_id = $1 AND assigned_to = $2 ${status ? 'AND status = $3' : ''}`,
      countParams
    );

    return { items: rows, total: cnt[0].total, page, limit };
  },

  async listForOrg(orgId, { status, assignedTo, q, page = 1, limit = 50 }) {
    const params = [orgId];
    const where = ['j.org_id = $1'];

    if (status) { params.push(status); where.push(`j.status = $${params.length}`); }
    if (assignedTo) { params.push(assignedTo); where.push(`j.assigned_to = $${params.length}`); }
    if (q) {
      params.push(q);
      where.push(`(j.ref ILIKE '%' || $${params.length} || '%'
                   OR c.name % $${params.length}
                   OR c.name ILIKE '%' || $${params.length} || '%')`);
    }

    params.push(limit, (page - 1) * limit);

    const { rows } = await query(
      `SELECT j.*, c.name AS customer_name, u.name AS driver_name
         FROM jobs j
         LEFT JOIN customers c ON c.id = j.customer_id
         LEFT JOIN users u ON u.id = j.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY j.updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const { rows: cnt } = await query(
      `SELECT count(*)::int AS total FROM jobs j
         LEFT JOIN customers c ON c.id = j.customer_id
        WHERE ${where.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { items: rows, total: cnt[0].total, page, limit };
  },

  async create(c, j) {
    const { rows } = await c.query(
      `INSERT INTO jobs (org_id, ref, customer_id, assigned_to, priority, address,
                         lat, lng, window_start, window_end, price, cod_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [j.org_id, j.ref, j.customer_id, j.assigned_to || null, j.priority || 0,
       j.address, j.lat, j.lng, j.window_start, j.window_end,
       j.price || 0, j.cod_amount || 0, j.assigned_to ? 'assigned' : 'draft']
    );
    return rows[0];
  },

  async officeUpdate(c, { orgId, id, fields, actorId, expectedVersion }) {
    const keys = Object.keys(fields);
    if (!keys.length) return { rowCount: 0, row: null };

    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    let p = keys.length;

    if ('assigned_to' in fields) {
      sets.push('previous_assigned_to = assigned_to');
    }

    sets.push('version = version + 1');
    const where = [`id = $${++p}`]; values.push(id);
    where.push(`org_id = $${++p}`); values.push(orgId);
    if (expectedVersion != null) {
      where.push(`version = $${++p}`);
      values.push(expectedVersion);
    }

    const { rows, rowCount } = await c.query(
      `UPDATE jobs SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`,
      values
    );
    return { rowCount, row: rows[0] || null };
  },

  async listEscalations(orgId, { page = 1, limit = 50 }) {
    const { rows } = await query(
      `SELECT m.*, j.ref, j.status AS current_status, u.name AS driver_name,
              EXTRACT(EPOCH FROM (m.received_at - m.client_ts))::int AS dark_seconds
         FROM mutations m
         LEFT JOIN jobs j ON j.id = m.entity_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.resolution = 'escalated'
        ORDER BY m.received_at DESC
        LIMIT $2 OFFSET $3`,
      [orgId, limit, (page - 1) * limit]
    );
    return rows;
  },

  async history(orgId, jobId) {
    const { rows } = await query(
      `SELECT m.mutation_id, m.type, m.outcome, m.resolution, m.resolution_reason,
              m.client_ts, m.received_at, m.payload,
              m.server_version_before, m.server_version_after,
              EXTRACT(EPOCH FROM (m.received_at - m.client_ts))::int AS dark_seconds,
              u.name AS actor_name, u.role AS actor_role,
              d.label AS device_label
         FROM mutations m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN devices d ON d.id = m.device_id
        WHERE m.org_id = $1 AND m.entity_id = $2
        ORDER BY m.received_at ASC`,
      [orgId, jobId]
    );
    return rows;
  },
};

const reportRepo = {
  async cashByDriver(orgId, { from, to }) {
    const { rows } = await query(
      `SELECT u.id, u.name,
              COALESCE(SUM(CASE WHEN ce.kind = 'collect' THEN ce.amount ELSE 0 END), 0) AS collected,
              COALESCE(SUM(CASE WHEN ce.kind = 'remit'   THEN ce.amount ELSE 0 END), 0) AS remitted,
              COALESCE(SUM(CASE WHEN ce.kind = 'collect' THEN ce.amount
                                WHEN ce.kind = 'remit'   THEN -ce.amount
                                ELSE 0 END), 0) AS outstanding
         FROM users u
         LEFT JOIN cash_entries ce
           ON ce.user_id = u.id AND ce.created_at BETWEEN $2 AND $3
        WHERE u.org_id = $1 AND u.role IN ('driver','salesman')
        GROUP BY u.id, u.name
        ORDER BY outstanding DESC`,
      [orgId, from, to]
    );
    return rows;
  },

  async darkTime(orgId, { from, to }) {
    const { rows } = await query(
      `SELECT u.id, u.name, d.label AS device,
              count(*)::int AS mutations,
              percentile_cont(0.5)  WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (m.received_at - m.client_ts))
              )::int AS p50_dark_seconds,
              percentile_cont(0.95) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (m.received_at - m.client_ts))
              )::int AS p95_dark_seconds,
              MAX(EXTRACT(EPOCH FROM (m.received_at - m.client_ts)))::int AS worst_dark_seconds
         FROM mutations m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN devices d ON d.id = m.device_id
        WHERE m.org_id = $1 AND m.received_at BETWEEN $2 AND $3
        GROUP BY u.id, u.name, d.label
        ORDER BY p95_dark_seconds DESC NULLS LAST`,
      [orgId, from, to]
    );
    return rows;
  },

  async conflictStats(orgId, { from, to }) {
    const { rows } = await query(
      `SELECT COALESCE(resolution, 'none') AS resolution,
              count(*)::int AS count
         FROM mutations
        WHERE org_id = $1 AND received_at BETWEEN $2 AND $3
          AND outcome IN ('conflict','applied')
        GROUP BY resolution
        ORDER BY count DESC`,
      [orgId, from, to]
    );
    return rows;
  },

  async deliveryStats(orgId, { from, to }) {
    const { rows } = await query(
      `SELECT status, count(*)::int AS count,
              COALESCE(SUM(cash_collected), 0) AS cash
         FROM jobs
        WHERE org_id = $1 AND updated_at BETWEEN $2 AND $3
        GROUP BY status`,
      [orgId, from, to]
    );
    return rows;
  },
};

module.exports = { userRepo, deviceRepo, jobRepo, reportRepo, withTransaction };
