const fs = require("fs");
const path = require("path");
const { getPool, query } = require("../src/db");
const { fulfillAllPendingRewards } = require("../src/bot");

async function main() {
  const file = process.argv[2];
  if (!file) {
    throw new Error("Usage: npm run import-cdks -- path/to/cdks.txt");
  }

  const fullPath = path.resolve(process.cwd(), file);
  const content = fs.readFileSync(fullPath, "utf8");
  const codes = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const batch = `file-${path.basename(file)}-${Date.now()}`;
  let inserted = 0;

  for (const code of codes) {
    const result = await query(
      "INSERT INTO cdks (code, batch) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING",
      [code, batch]
    );
    inserted += result.rowCount;
  }

  console.log(`Imported ${inserted} CDKs. Skipped ${codes.length - inserted} duplicates.`);
  await fulfillAllPendingRewards();
  await getPool().end();
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
