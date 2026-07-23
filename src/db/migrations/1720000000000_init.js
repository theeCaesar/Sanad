/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
  pgm.createExtension('pg_trgm', { ifNotExists: true });

  pgm.createTable('orgs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },
    modules: { type: 'text[]', notNull: true, default: pgm.func(`ARRAY['delivery']::text[]`) },
    locale: { type: 'text', notNull: true, default: 'en' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text', notNull: true },
    password_hash: { type: 'text' },
    role: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    token_version: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('users', 'users_role_check', {
    check: `role IN ('admin','dispatcher','driver','salesman')`,
  });
  pgm.addConstraint('users', 'users_org_phone_unique', { unique: ['org_id', 'phone'] });
  pgm.createIndex('users', ['org_id', 'role']);

  pgm.createTable('devices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    label: { type: 'text' },
    platform: { type: 'text' },
    last_applied_seq: { type: 'bigint', notNull: true, default: 0 },
    last_pulled_at: { type: 'timestamptz' },
    last_seen_at: { type: 'timestamptz' },
    revoked: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('devices', ['org_id', 'user_id']);

  pgm.createTable('customers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    shop_name: { type: 'text' },
    lat: { type: 'double precision' },
    lng: { type: 'double precision' },
    address: { type: 'text' },
    balance: { type: 'bigint', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('customers', ['org_id']);
  pgm.sql(`CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);`);
  pgm.sql(`CREATE INDEX customers_shop_trgm ON customers USING gin (shop_name gin_trgm_ops);`);

  pgm.createTable('jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    ref: { type: 'text', notNull: true },
    customer_id: { type: 'uuid', references: 'customers' },

    assigned_to: { type: 'uuid', references: 'users' },
    priority: { type: 'integer', notNull: true, default: 0 },
    address: { type: 'text' },
    lat: { type: 'double precision' },
    lng: { type: 'double precision' },
    window_start: { type: 'timestamptz' },
    window_end: { type: 'timestamptz' },
    price: { type: 'bigint', notNull: true, default: 0 },
    cod_amount: { type: 'bigint', notNull: true, default: 0 },

    status: { type: 'text', notNull: true, default: 'draft' },
    accepted_at: { type: 'timestamptz' },
    picked_up_at: { type: 'timestamptz' },
    delivered_at: { type: 'timestamptz' },
    failure_reason: { type: 'text' },
    cash_collected: { type: 'bigint', notNull: true, default: 0 },
    proof_media_key: { type: 'text' },
    recipient_name: { type: 'text' },
    field_note: { type: 'text' },
    delivered_lat: { type: 'double precision' },
    delivered_lng: { type: 'double precision' },

    version: { type: 'integer', notNull: true, default: 1 },
    last_mutation_id: { type: 'uuid' },
    last_device_id: { type: 'uuid', references: 'devices' },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('jobs', 'jobs_status_check', {
    check: `status IN ('draft','assigned','accepted','picked_up','delivered','failed','cancelled')`,
  });
  pgm.addConstraint('jobs', 'jobs_cash_nonneg', { check: 'cash_collected >= 0' });
  pgm.addConstraint('jobs', 'jobs_org_ref_unique', { unique: ['org_id', 'ref'] });
  pgm.createIndex('jobs', ['org_id', 'status']);
  pgm.createIndex('jobs', ['org_id', 'assigned_to', 'status']);
  pgm.createIndex('jobs', ['org_id', 'updated_at']);

  pgm.createTable('routes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    assigned_to: { type: 'uuid', references: 'users' },
    day_of_week: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('visits', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    route_id: { type: 'uuid', references: 'routes' },
    customer_id: { type: 'uuid', notNull: true, references: 'customers' },

    assigned_to: { type: 'uuid', references: 'users' },
    planned_for: { type: 'timestamptz' },

    status: { type: 'text', notNull: true, default: 'planned' },
    checked_in_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    skip_reason: { type: 'text' },
    field_note: { type: 'text' },
    checkin_lat: { type: 'double precision' },
    checkin_lng: { type: 'double precision' },

    version: { type: 'integer', notNull: true, default: 1 },
    last_mutation_id: { type: 'uuid' },
    last_device_id: { type: 'uuid', references: 'devices' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('visits', 'visits_status_check', {
    check: `status IN ('planned','checked_in','completed','skipped','cancelled')`,
  });
  pgm.createIndex('visits', ['org_id', 'assigned_to', 'status']);
  pgm.createIndex('visits', ['org_id', 'updated_at']);

  pgm.createTable('products', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    sku: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    unit_price: { type: 'bigint', notNull: true, default: 0 },
    low_stock_threshold: { type: 'integer', notNull: true, default: 10 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('products', 'products_org_sku_unique', { unique: ['org_id', 'sku'] });
  pgm.sql(`CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);`);

  pgm.createTable('van_stock', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    product_id: { type: 'uuid', notNull: true, references: 'products', onDelete: 'CASCADE' },
    qty: { type: 'integer', notNull: true, default: 0 },
    version: { type: 'integer', notNull: true, default: 1 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('van_stock', 'van_stock_qty_nonneg', { check: 'qty >= 0' });
  pgm.addConstraint('van_stock', 'van_stock_unique', { unique: ['user_id', 'product_id'] });
  pgm.createIndex('van_stock', ['org_id', 'user_id']);

  pgm.createTable('orders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    visit_id: { type: 'uuid', references: 'visits' },
    customer_id: { type: 'uuid', notNull: true, references: 'customers' },
    created_by: { type: 'uuid', notNull: true, references: 'users' },
    subtotal: { type: 'bigint', notNull: true, default: 0 },
    discount: { type: 'bigint', notNull: true, default: 0 },
    total: { type: 'bigint', notNull: true, default: 0 },
    paid: { type: 'bigint', notNull: true, default: 0 },
    client_ts: { type: 'timestamptz' },
    version: { type: 'integer', notNull: true, default: 1 },
    last_mutation_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('orders', 'orders_totals_nonneg', {
    check: 'subtotal >= 0 AND discount >= 0 AND total >= 0 AND paid >= 0',
  });
  pgm.createIndex('orders', ['org_id', 'created_by', 'created_at']);

  pgm.createTable('order_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    order_id: { type: 'uuid', notNull: true, references: 'orders', onDelete: 'CASCADE' },
    product_id: { type: 'uuid', notNull: true, references: 'products' },
    qty: { type: 'integer', notNull: true },
    unit_price: { type: 'bigint', notNull: true },
    line_total: { type: 'bigint', notNull: true },
  });
  pgm.addConstraint('order_lines', 'order_lines_qty_positive', { check: 'qty > 0' });
  pgm.createIndex('order_lines', ['order_id']);

  pgm.createTable('cash_entries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users' },
    job_id: { type: 'uuid', references: 'jobs' },
    order_id: { type: 'uuid', references: 'orders' },
    amount: { type: 'bigint', notNull: true },
    kind: { type: 'text', notNull: true },
    mutation_id: { type: 'uuid', unique: true },
    client_ts: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('cash_entries', 'cash_kind_check', {
    check: `kind IN ('collect','remit','adjust')`,
  });
  pgm.createIndex('cash_entries', ['org_id', 'user_id', 'created_at']);

  pgm.createTable('mutations', {
    mutation_id: { type: 'uuid', primaryKey: true },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    device_id: { type: 'uuid', notNull: true, references: 'devices' },
    user_id: { type: 'uuid', notNull: true, references: 'users' },

    seq: { type: 'bigint', notNull: true },
    type: { type: 'text', notNull: true },
    entity: { type: 'text', notNull: true },
    entity_id: { type: 'uuid' },
    payload: { type: 'jsonb', notNull: true },
    base_version: { type: 'integer' },

    client_ts: { type: 'timestamptz', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },

    outcome: { type: 'text', notNull: true },
    resolution: { type: 'text' },
    resolution_reason: { type: 'text' },
    server_version_before: { type: 'integer' },
    server_version_after: { type: 'integer' },
    error: { type: 'text' },
  });
  pgm.addConstraint('mutations', 'mutations_outcome_check', {
    check: `outcome IN ('applied','duplicate','conflict','rejected')`,
  });
  pgm.addConstraint('mutations', 'mutations_device_seq_unique', { unique: ['device_id', 'seq'] });
  pgm.createIndex('mutations', ['org_id', 'received_at']);
  pgm.createIndex('mutations', ['entity', 'entity_id']);
  pgm.createIndex('mutations', ['org_id', 'outcome']);
  pgm.sql(`CREATE INDEX mutations_escalated ON mutations (org_id, received_at)
           WHERE resolution = 'escalated';`);

  pgm.createTable('outbox', {
    id: { type: 'bigserial', primaryKey: true },
    org_id: { type: 'uuid', notNull: true },
    topic: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    partition_key: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    trace_id: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'pending' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    published_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('outbox', 'outbox_status_check', {
    check: `status IN ('pending','published','failed')`,
  });
  pgm.sql(`CREATE INDEX outbox_pending ON outbox (id) WHERE status = 'pending';`);
  pgm.createIndex('outbox', ['status', 'created_at']);

  pgm.createTable('sagas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true },
    type: { type: 'text', notNull: true },
    correlation_id: { type: 'uuid', notNull: true },
    state: { type: 'text', notNull: true, default: 'running' },
    current_step: { type: 'text' },
    completed_steps: { type: 'text[]', notNull: true, default: '{}' },
    compensated_steps: { type: 'text[]', notNull: true, default: '{}' },
    context: { type: 'jsonb', notNull: true, default: '{}' },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('sagas', 'sagas_state_check', {
    check: `state IN ('running','completed','compensating','compensated','failed')`,
  });
  pgm.createIndex('sagas', ['state', 'updated_at']);
  pgm.createIndex('sagas', ['correlation_id']);

  pgm.createTable('notifications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'CASCADE' },
    key: { type: 'text', notNull: true },
    params: { type: 'jsonb', notNull: true, default: '{}' },
    severity: { type: 'text', notNull: true, default: 'info' },
    read_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('notifications', ['org_id', 'user_id', 'read_at']);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
  `);
  for (const t of ['users', 'jobs', 'visits', 'sagas']) {
    pgm.sql(`CREATE TRIGGER ${t}_touch BEFORE UPDATE ON ${t}
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at();`);
  }
};

exports.down = (pgm) => {
  for (const t of [
    'notifications', 'sagas', 'outbox', 'mutations', 'cash_entries',
    'order_lines', 'orders', 'van_stock', 'products', 'visits', 'routes',
    'jobs', 'customers', 'devices', 'users', 'orgs',
  ]) {
    pgm.dropTable(t, { ifExists: true, cascade: true });
  }
  pgm.sql('DROP FUNCTION IF EXISTS touch_updated_at() CASCADE;');
};
