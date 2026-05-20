const fs = require("fs");
const path = require("path");
const { getPool, query } = require("../src/db");

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8");
  await query(schema);
  await getPool().end();
  console.log("Database migrated.");
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error);
    try {
      await getPool().end();
    } catch (_) {
      // Ignore shutdown failures.
    }
    process.exit(1);
  });
}
