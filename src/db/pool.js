const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool;

function createPool(connectionString = process.env.DATABASE_URL) {
  return new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: 5000,
  });
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

async function query(text, params) {
  const start = Date.now();
  const res = await getPool().query(text, params);
  const ms = Date.now() - start;
  if (ms > 200) logger.warn({ ms, text: text.slice(0, 120) }, 'slow query');
  return res;
}

async function withTransaction(fn, opts = {}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (opts.isolation) {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'ROLLBACK failed — destroying connection');
      client.release(rollbackErr);
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function setPool(p) {
  pool = p;
}

module.exports = { createPool, getPool, setPool, query, withTransaction, close };
