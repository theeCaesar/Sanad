/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable('stock_reservations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_id: { type: 'uuid', notNull: true, references: 'orgs', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    idempotency_key: { type: 'text', notNull: true },
    lines: { type: 'jsonb', notNull: true },
    total: { type: 'bigint', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'reserved' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('stock_reservations', 'stock_reservations_idem_unique', {
    unique: ['org_id', 'idempotency_key'],
  });
  pgm.createIndex('stock_reservations', ['org_id', 'user_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('stock_reservations');
};
