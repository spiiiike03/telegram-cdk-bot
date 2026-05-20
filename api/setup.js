const fs = require("fs");
const path = require("path");
const { config } = require("../src/config");
const { query } = require("../src/db");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!config.setupSecret) {
    res.status(500).json({ ok: false, error: "SETUP_SECRET is not configured" });
    return;
  }

  if (req.headers["x-setup-secret"] !== config.setupSecret) {
    res.status(401).json({ ok: false, error: "Invalid setup secret" });
    return;
  }

  const schema = fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8");
  await query(schema);
  res.status(200).json({ ok: true, migrated: true });
};
