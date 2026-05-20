const { Pool } = require("pg");
const { config } = require("./config");

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseUrl.includes("sslmode=require")
        ? { rejectUnauthorized: false }
        : undefined,
      max: 3,
      idleTimeoutMillis: 10000
    });
  }

  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  query,
  transaction
};
