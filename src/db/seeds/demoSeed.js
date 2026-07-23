const bcrypt = require('bcryptjs');

function createDemoSeeder({ db, authService, logger }) {
  return async function seedDemo() {
    return db.withTransaction(async (client) => {
      const slug = `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      const org = await client.query(
        `INSERT INTO orgs (name, slug, modules, locale)
         VALUES ($1, $2, ARRAY['delivery','field_sales']::text[], 'en')
         RETURNING *`,
        ['Sanad Demo', slug]
      );
      const orgId = org.rows[0].id;

      const hash = await bcrypt.hash('demo-password-not-secret', 10);

      const users = await client.query(
        `INSERT INTO users (org_id, name, phone, password_hash, role) VALUES
           ($1, 'Ali (driver)',      $2, $5, 'driver'),
           ($1, 'Omar (driver)',     $3, $5, 'driver'),
           ($1, 'Zaid (dispatcher)', $4, $5, 'dispatcher')
         RETURNING id, name, role`,
        [orgId, `${slug}-1`, `${slug}-2`, `${slug}-3`, hash]
      );

      const driver = users.rows.find((u) => u.name.startsWith('Ali'));
      const otherDriver = users.rows.find((u) => u.name.startsWith('Omar'));
      const dispatcher = users.rows.find((u) => u.role === 'dispatcher');

      const dev = await client.query(
        `INSERT INTO devices (org_id, user_id, label, platform)
         VALUES ($1, $2, 'Ali''s Samsung', 'android') RETURNING *`,
        [orgId, driver.id]
      );
      const device = dev.rows[0];

      await client.query(
        `INSERT INTO devices (org_id, user_id, label, platform, last_seen_at)
         VALUES ($1, $2, 'Omar''s Samsung', 'android', now() - interval '3 hours')`,
        [orgId, otherDriver.id]
      );

      const customers = await client.query(
        `INSERT INTO customers (org_id, name, phone, address, lat, lng) VALUES
           ($1, 'Um Ahmed',   '0770-111', 'Abu Ghraib, Baghdad', 33.3400, 44.1800),
           ($1, 'Abu Hassan', '0770-222', 'Karrada, Baghdad',    33.3050, 44.4200),
           ($1, 'Sara Market','0770-333', 'Mansour, Baghdad',    33.3150, 44.3400)
         RETURNING id, name`,
        [orgId]
      );

      const jobs = await client.query(
        `INSERT INTO jobs (org_id, ref, customer_id, assigned_to, status, address,
                           lat, lng, price, cod_amount, priority,
                           delivered_at, cash_collected, recipient_name)
         VALUES
           ($1, 'JOB-1001', $2, $5, 'picked_up', 'Abu Ghraib, Baghdad', 33.3400, 44.1800, 15000, 25000, 5, NULL, 0, NULL),
           ($1, 'JOB-1002', $3, $5, 'accepted',  'Karrada, Baghdad',    33.3050, 44.4200, 12000, 12000, 3, NULL, 0, NULL),
           ($1, 'JOB-1003', $4, $5, 'assigned',  'Mansour, Baghdad',    33.3150, 44.3400, 20000,     0, 1, NULL, 0, NULL),
           -- Already delivered THIS MORNING, before the visitor opened either
           -- app. Without at least one closed job, "deliveries today" and every
           -- cash figure on the dispatcher board reads zero on a brand new
           -- session, which looks like the page is broken rather than like a
           -- business day that is genuinely still young.
           ($1, 'JOB-1004', $2, $6, 'delivered', 'Abu Ghraib, Baghdad', 33.3400, 44.1800, 18000, 18000, 2,
              now() - interval '4 hours', 18000, 'Abu Hassan'),
           ($1, 'JOB-1005', $3, NULL,'draft',    'Karrada, Baghdad',    33.3050, 44.4200,  9000,     0, 0, NULL, 0, NULL)
         RETURNING id, ref, status, version, assigned_to, cod_amount`,
        [orgId, customers.rows[0].id, customers.rows[1].id, customers.rows[2].id,
         driver.id, otherDriver.id]
      );

      await client.query(
        `INSERT INTO cash_entries (org_id, user_id, job_id, amount, kind, client_ts) VALUES
           ($1, $2, $4, 22000, 'collect', now() - interval '5 hours'),
           ($1, $3, $5, 18000, 'collect', now() - interval '4 hours'),
           ($1, $3, $5,  3000, 'remit',   now() - interval '3 hours')`,
        [orgId, driver.id, otherDriver.id, jobs.rows[0].id, jobs.rows[3].id]
      );

      await client.query(
        `INSERT INTO mutations (mutation_id, org_id, device_id, user_id, seq, type, entity,
                                 entity_id, payload, base_version, client_ts,
                                 outcome, resolution, resolution_reason)
         VALUES (gen_random_uuid(), $1, $2, $3, 9001, 'job.deliver', 'job', $4,
                 '{"recipient_name":"Um Ahmed"}'::jsonb, 1, now() - interval '2 hours',
                 'conflict', 'escalated',
                 'Another device also reported this job delivered around the same time. The system will not guess which delivery is real — a dispatcher must decide.')`,
        [orgId, device.id, driver.id, jobs.rows[1].id]
      );

      const products = await client.query(
        `INSERT INTO products (org_id, sku, name, unit_price, low_stock_threshold) VALUES
           ($1, 'WTR-1L',  'Water 1L',    1000, 20),
           ($1, 'BRD-STD', 'Bread',        500, 10),
           ($1, 'RCE-5KG', 'Rice 5kg',    7000,  5)
         RETURNING id, sku, name, unit_price`,
        [orgId]
      );

      for (const p of products.rows) {
        await client.query(
          `INSERT INTO van_stock (org_id, user_id, product_id, qty) VALUES ($1,$2,$3,$4)`,
          [orgId, driver.id, p.id, 30]
        );
      }

      const driverRow = { ...driver, org_id: orgId, token_version: 0 };
      const dispatcherRow = { ...dispatcher, org_id: orgId, token_version: 0 };

      const deviceToken = authService.signDevice(driverRow, device);
      const dispatcherToken = authService.signAccess(dispatcherRow);

      logger.info({ orgId, slug }, 'demo: seeded');

      return {
        orgId,
        slug,
        driver,
        otherDriverId: otherDriver.id,
        dispatcher,
        deviceId: device.id,
        deviceToken,
        dispatcherToken,
        jobs: jobs.rows,
        products: products.rows,
        customers: customers.rows,
      };
    });
  };
}

async function sweepDemoOrgs(db, { olderThanHours = 1 } = {}) {
  const { rowCount } = await db.query(
    `DELETE FROM orgs
      WHERE slug LIKE 'demo-%'
        AND created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours]
  );
  return rowCount;
}

module.exports = { createDemoSeeder, sweepDemoOrgs };
