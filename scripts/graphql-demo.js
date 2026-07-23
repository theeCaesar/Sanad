const { ApolloServer } = require('@apollo/server');
const { typeDefs } = require('../src/graphql/schema');
const { resolvers, createLoaders } = require('../src/graphql/resolvers');

let queryCount = 0;
const db = {
  async query(sql, params) {
    queryCount++;
    if (sql.includes('FROM users')) {
      const ids = params[1];
      return { rows: ids.map(id => ({ id, name: 'سائق ' + id, role: 'driver' })) };
    }
    if (sql.includes('FROM customers')) {
      const ids = params[1];
      return { rows: ids.map(id => ({ id, name: 'زبون ' + id, phone: '0770', address: 'بغداد' })) };
    }
    if (sql.includes('cash_entries')) {
      return { rows: (params[1]).map(id => ({ user_id: id, outstanding: 25000 })) };
    }
    return { rows: [] };
  },
};

const repos = {
  jobRepo: {
    async listForOrg() {
      return {
        items: [
          { id: 'j1', ref: 'JOB-1', status: 'delivered', version: 2, cod_amount: 25000, price: 15000, assigned_to: 'd1', customer_id: 'c1', created_at: 'x', updated_at: 'y' },
          { id: 'j2', ref: 'JOB-2', status: 'picked_up', version: 1, cod_amount: 12000, price: 12000, assigned_to: 'd1', customer_id: 'c2', created_at: 'x', updated_at: 'y' },
          { id: 'j3', ref: 'JOB-3', status: 'assigned', version: 1, cod_amount: 0, price: 20000, assigned_to: 'd2', customer_id: 'c1', created_at: 'x', updated_at: 'y' },
        ],
        total: 3,
      };
    },
  },
};

(async () => {
  const server = new ApolloServer({ typeDefs, resolvers });
  await server.start();

  const query = `
    query Board {
      jobs {
        total
        items {
          ref
          status
          codAmount
          driver { name cashOutstanding }
          customer { name }
        }
      }
    }
  `;

  const res = await server.executeOperation(
    { query },
    { contextValue: { orgId: 'o1', db, repos, loaders: createLoaders(db, 'o1') } }
  );

  const data = res.body.singleResult.data;
  const errors = res.body.singleResult.errors;
  if (errors) { console.error('GQL errors:', JSON.stringify(errors, null, 2)); process.exit(1); }

  console.log('✓ Query returned', data.jobs.total, 'jobs');
  data.jobs.items.forEach(j => {
    console.log(`  ${j.ref} [${j.status}] → ${j.driver.name} (cash: ${j.driver.cashOutstanding}) → ${j.customer.name}`);
  });

  console.log('\n✓ Total DB queries:', queryCount, '(naive N+1 would be ~10)');
  console.log(queryCount <= 4 ? '✅ GraphQL + DataLoader: batching WORKS — no N+1' : '⚠️ more queries than expected');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
