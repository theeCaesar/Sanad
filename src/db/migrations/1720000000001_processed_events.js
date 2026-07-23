/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable('processed_events', {
    event_id: { type: 'text', notNull: true },
    consumer_group: { type: 'text', notNull: true },
    processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('processed_events', 'processed_events_pk', {
    primaryKey: ['event_id', 'consumer_group'],
  });

  pgm.createIndex('processed_events', ['processed_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('processed_events', { ifExists: true });
};
