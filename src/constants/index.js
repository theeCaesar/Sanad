
const ROLES = Object.freeze({
  ADMIN: 'admin',
  DISPATCHER: 'dispatcher',
  DRIVER: 'driver',
  SALESMAN: 'salesman',
});

const FIELD_ROLES = Object.freeze([ROLES.DRIVER, ROLES.SALESMAN]);

const MODULES = Object.freeze({
  DELIVERY: 'delivery',
  FIELD_SALES: 'field_sales',
});

const JOB_STATUS = Object.freeze({
  DRAFT: 'draft',
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  PICKED_UP: 'picked_up',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const PHYSICAL_TERMINAL = Object.freeze([JOB_STATUS.DELIVERED, JOB_STATUS.FAILED]);

const ADMIN_TERMINAL = Object.freeze([JOB_STATUS.CANCELLED]);

const TERMINAL_STATUSES = Object.freeze([...PHYSICAL_TERMINAL, ...ADMIN_TERMINAL]);

const JOB_TRANSITIONS = Object.freeze({
  [JOB_STATUS.DRAFT]: [JOB_STATUS.ASSIGNED, JOB_STATUS.CANCELLED],
  [JOB_STATUS.ASSIGNED]: [JOB_STATUS.ACCEPTED, JOB_STATUS.CANCELLED, JOB_STATUS.ASSIGNED],
  [JOB_STATUS.ACCEPTED]: [JOB_STATUS.PICKED_UP, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED],
  [JOB_STATUS.PICKED_UP]: [JOB_STATUS.DELIVERED, JOB_STATUS.FAILED],
  [JOB_STATUS.DELIVERED]: [],
  [JOB_STATUS.FAILED]: [],
  [JOB_STATUS.CANCELLED]: [],
});

const VISIT_STATUS = Object.freeze({
  PLANNED: 'planned',
  CHECKED_IN: 'checked_in',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
});

const VISIT_TRANSITIONS = Object.freeze({
  [VISIT_STATUS.PLANNED]: [VISIT_STATUS.CHECKED_IN, VISIT_STATUS.SKIPPED, VISIT_STATUS.CANCELLED],
  [VISIT_STATUS.CHECKED_IN]: [VISIT_STATUS.COMPLETED, VISIT_STATUS.SKIPPED],
  [VISIT_STATUS.COMPLETED]: [],
  [VISIT_STATUS.SKIPPED]: [],
  [VISIT_STATUS.CANCELLED]: [],
});

const MUTATION_TYPES = Object.freeze({
  JOB_ACCEPT: 'job.accept',
  JOB_PICKUP: 'job.pickup',
  JOB_DELIVER: 'job.deliver',
  JOB_FAIL: 'job.fail',
  CASH_COLLECT: 'cash.collect',
  PROOF_ATTACH: 'proof.attach',

  VISIT_CHECKIN: 'visit.checkin',
  VISIT_COMPLETE: 'visit.complete',
  VISIT_SKIP: 'visit.skip',
  ORDER_CREATE: 'order.create',
  STOCK_ADJUST: 'stock.adjust',
  PAYMENT_COLLECT: 'payment.collect',
});

const MUTATION_MODULE = Object.freeze({
  [MUTATION_TYPES.JOB_ACCEPT]: MODULES.DELIVERY,
  [MUTATION_TYPES.JOB_PICKUP]: MODULES.DELIVERY,
  [MUTATION_TYPES.JOB_DELIVER]: MODULES.DELIVERY,
  [MUTATION_TYPES.JOB_FAIL]: MODULES.DELIVERY,
  [MUTATION_TYPES.CASH_COLLECT]: MODULES.DELIVERY,
  [MUTATION_TYPES.PROOF_ATTACH]: MODULES.DELIVERY,
  [MUTATION_TYPES.VISIT_CHECKIN]: MODULES.FIELD_SALES,
  [MUTATION_TYPES.VISIT_COMPLETE]: MODULES.FIELD_SALES,
  [MUTATION_TYPES.VISIT_SKIP]: MODULES.FIELD_SALES,
  [MUTATION_TYPES.ORDER_CREATE]: MODULES.FIELD_SALES,
  [MUTATION_TYPES.STOCK_ADJUST]: MODULES.FIELD_SALES,
  [MUTATION_TYPES.PAYMENT_COLLECT]: MODULES.FIELD_SALES,
});

const SYNC_OUTCOME = Object.freeze({
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

const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  PUBLISHED: 'published',
  FAILED: 'failed',
});

const EVENTS = Object.freeze({
  JOB_ASSIGNED: 'job.assigned',
  JOB_ACCEPTED: 'job.accepted',
  JOB_PICKED_UP: 'job.picked_up',
  JOB_DELIVERED: 'job.delivered',
  JOB_FAILED: 'job.failed',
  CASH_COLLECTED: 'cash.collected',
  VISIT_COMPLETED: 'visit.completed',
  ORDER_CREATED: 'order.created',
  STOCK_LOW: 'stock.low',
  SYNC_CONFLICT_ESCALATED: 'sync.conflict_escalated',
});

const TOPICS = Object.freeze({
  JOBS: 'sanad.jobs',
  SALES: 'sanad.sales',
  INVENTORY: 'sanad.inventory',
  NOTIFICATIONS: 'sanad.notifications',
  DLQ: 'sanad.dlq',
});

const CURRENCY = Object.freeze({ IQD: 'IQD', USD: 'USD' });

const LOCALES = Object.freeze(['en', 'ar', 'ku']);
const DEFAULT_LOCALE = 'en';

module.exports = {
  ROLES,
  FIELD_ROLES,
  MODULES,
  JOB_STATUS,
  JOB_TRANSITIONS,
  PHYSICAL_TERMINAL,
  ADMIN_TERMINAL,
  TERMINAL_STATUSES,
  VISIT_STATUS,
  VISIT_TRANSITIONS,
  MUTATION_TYPES,
  MUTATION_MODULE,
  SYNC_OUTCOME,
  RESOLUTION,
  OUTBOX_STATUS,
  EVENTS,
  TOPICS,
  CURRENCY,
  LOCALES,
  DEFAULT_LOCALE,
};
