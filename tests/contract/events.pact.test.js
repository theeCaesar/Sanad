
const path = require('path');
const { MessageConsumerPact, MessageProviderPact, Matchers, providerWithMetadata } = require('@pact-foundation/pact');
const { like, iso8601DateTimeWithMillis, uuid, term } = Matchers;

const { handlers } = require('../../src/workers/notificationConsumer');
const { EVENTS } = require('../../src/constants');

const PACT_DIR = path.resolve(__dirname, '../../pacts');

describe('CONSUMER (notifications) declares what it needs', () => {
  const messagePact = new MessageConsumerPact({
    consumer: 'sanad-notification-consumer',
    provider: 'sanad-sync-service',
    dir: PACT_DIR,
    logLevel: 'warn',
  });

  test('job.delivered MUST carry BOTH timestamps', () => {
    return messagePact
      .expectsToReceive('a job.delivered event')
      .withContent({
        event_type: 'job.delivered',
        org_id: uuid(),
        entity_id: uuid(),
        status: term({ matcher: 'delivered', generate: 'delivered' }),
        version: like(2),

        happened_at: iso8601DateTimeWithMillis(),
        synced_at: iso8601DateTimeWithMillis(),

        device_id: uuid(),
        user_id: uuid(),
      })
      .withMetadata({ 'content-type': 'application/json' })
      .verify(async (message) => {
        const evt = message.contents;

        const fakeClient = {
          query: async (sql, params) => {
            if (sql.includes('notifications')) {
              expect(params).toContain(evt.happened_at);
            }
            return { rows: [], rowCount: 1 };
          },
        };

        await handlers[EVENTS.JOB_DELIVERED](fakeClient, evt);
      });
  });

  test('sync.conflict_escalated MUST carry a human-readable reason', () => {
    return messagePact
      .expectsToReceive('a sync.conflict_escalated event')
      .withContent({
        event_type: 'sync.conflict_escalated',
        org_id: uuid(),
        entity_id: uuid(),
        mutation_id: uuid(),

        reason: like('Equal rank with overlapping fields. The system refuses to guess.'),

        server_status: like('accepted'),
        device_wanted: like({ status: 'delivered' }),
      })
      .withMetadata({ 'content-type': 'application/json' })
      .verify(async (message) => {
        const evt = message.contents;
        expect(evt.reason).toBeTruthy();
        expect(typeof evt.reason).toBe('string');

        const fakeClient = { query: async () => ({ rows: [], rowCount: 1 }) };
        await handlers[EVENTS.SYNC_CONFLICT_ESCALATED](fakeClient, evt);
      });
  });

  test('stock.low MUST carry the remaining quantity', () => {
    return messagePact
      .expectsToReceive('a stock.low event')
      .withContent({
        event_type: 'stock.low',
        org_id: uuid(),
        product_id: uuid(),
        user_id: uuid(),
        remaining: like(3),
      })
      .withMetadata({ 'content-type': 'application/json' })
      .verify(async (message) => {
        const evt = message.contents;
        expect(typeof evt.remaining).toBe('number');

        const fakeClient = { query: async () => ({ rows: [], rowCount: 1 }) };
        await handlers[EVENTS.STOCK_LOW](fakeClient, evt);
      });
  });
});

describe('PROVIDER (sync service) must honour the contract', () => {
  const { buildEventPayload } = require('../../src/services/eventPayloads');

  const withMetadata = (provider) => providerWithMetadata(provider, { 'content-type': 'application/json' });

  const provider = new MessageProviderPact({
    messageProviders: {
      'a job.delivered event': withMetadata(() => buildEventPayload(EVENTS.JOB_DELIVERED, {
        orgId: '11111111-1111-4111-8111-111111111111',
        entityId: '22222222-2222-4222-8222-222222222222',
        status: 'delivered',
        version: 2,
        clientTs: '2026-07-13T14:02:00.000Z',
        syncedAt: '2026-07-13T17:00:00.000Z',
        deviceId: '33333333-3333-4333-8333-333333333333',
        userId: '44444444-4444-4444-8444-444444444444',
      })),

      'a sync.conflict_escalated event': withMetadata(() => buildEventPayload(EVENTS.SYNC_CONFLICT_ESCALATED, {
        orgId: '11111111-1111-4111-8111-111111111111',
        entityId: '22222222-2222-4222-8222-222222222222',
        mutationId: '55555555-5555-4555-8555-555555555555',
        reason: 'Equal rank with overlapping fields. The system refuses to guess.',
        serverStatus: 'accepted',
        deviceWanted: { status: 'delivered' },
      })),

      'a stock.low event': withMetadata(() => buildEventPayload(EVENTS.STOCK_LOW, {
        orgId: '11111111-1111-4111-8111-111111111111',
        productId: '66666666-6666-4666-8666-666666666666',
        userId: '44444444-4444-4444-8444-444444444444',
        remaining: 3,
      })),
    },

    provider: 'sanad-sync-service',
    pactUrls: [path.resolve(PACT_DIR, 'sanad-notification-consumer-sanad-sync-service.json')],
    logLevel: 'warn',
  });

  test('every consumer expectation is satisfied by the real payload builder', () => {
    return provider.verify();
  });
});
