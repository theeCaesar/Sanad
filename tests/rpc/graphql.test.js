
const { ApolloServer } = require('@apollo/server');
const { typeDefs } = require('../../src/graphql/schema');
const { resolvers, createLoaders } = require('../../src/graphql/resolvers');

function countingDb() {
  const state = { count: 0 };
  return {
    state,
    async query(sql, params) {
      state.count++;
      if (sql.includes('FROM users')) return { rows: params[1].map(id => ({ id, name: 'D' + id, role: 'driver' })) };
      if (sql.includes('FROM customers')) return { rows: params[1].map(id => ({ id, name: 'C' + id, phone: '1', address: 'A' })) };
      if (sql.includes('cash_entries')) return { rows: params[1].map(id => ({ user_id: id, outstanding: 25000 })) };
      return { rows: [] };
    },
  };
}

const repos = {
  jobRepo: {
    async listForOrg() {
      return {
        items: [
          { id: 'j1', ref: 'JOB-1', status: 'delivered', version: 2, cod_amount: 25000, price: 15000, assigned_to: 'd1', customer_id: 'c1', created_at: 'x', updated_at: 'y' },
          { id: 'j2', ref: 'JOB-2', status: 'picked_up', version: 1, cod_amount: 12000, price: 12000, assigned_to: 'd1', customer_id: 'c2', created_at: 'x', updated_at: 'y' },
          { id: 'j3', ref: 'JOB-3', status: 'assigned', version: 1, cod_amount: 0, price: 20000, assigned_to: 'd2', customer_id: 'c1', created_at: 'x', updated_at: 'y' },
        ], total: 3,
      };
    },
    async findById(orgId, id) {
      return { id, ref: 'JOB-1', status: 'delivered', version: 2, cod_amount: 25000, price: 15000, assigned_to: 'd1', customer_id: 'c1', created_at: 'x', updated_at: 'y' };
    },
    async history() {
      return [{ mutation_id: 'm1', type: 'job.deliver', outcome: 'applied', resolution: 'field_wins',
        resolution_reason: 'physical truth outranks admin', client_ts: 'T1', received_at: 'T2',
        dark_seconds: 10680, user_id: 'd1', device_label: 'Ali phone' }];
    },
  },
};

let server;
beforeAll(async () => { server = new ApolloServer({ typeDefs, resolvers }); await server.start(); });
afterAll(async () => { await server.stop(); });

async function run(query) {
  const db = countingDb();
  const res = await server.executeOperation({ query },
    { contextValue: { orgId: 'o1', db, repos, loaders: createLoaders(db, 'o1') } });
  return { data: res.body.singleResult.data, errors: res.body.singleResult.errors, queries: db.state.count };
}

test('the board query resolves the whole tree in ONE request', async () => {
  const { data, errors } = await run(`{ jobs { total items { ref status driver { name } customer { name } } } }`);
  expect(errors).toBeUndefined();
  expect(data.jobs.total).toBe(3);
  expect(data.jobs.items[0].driver.name).toBeTruthy();
  expect(data.jobs.items[0].customer.name).toBeTruthy();
});

test('DataLoader BATCHES — 3 jobs, 2 drivers, 2 customers → NOT 10 queries', async () => {
  const { queries } = await run(`{ jobs { items { ref driver { name cashOutstanding } customer { name } } } }`);
  expect(queries).toBeLessThanOrEqual(3);
});

test('over-fetching is impossible — a field the query omits never runs', async () => {
  const { queries } = await run(`{ jobs { items { ref } } }`);
  expect(queries).toBe(0);
});

test('the detail view pulls the full history tree', async () => {
  const { data, errors } = await run(`{ job(id: "j1") { ref history { type resolutionReason darkSeconds actor { name } } } }`);
  expect(errors).toBeUndefined();
  expect(data.job.history[0].resolutionReason).toMatch(/physical truth/);
  expect(data.job.history[0].darkSeconds).toBe(10680);
  expect(data.job.history[0].actor.name).toBeTruthy();
});
