const { config } = require("../src/config");
const { telegram } = require("../src/telegram");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
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

  const webhookInfo = await telegram("getWebhookInfo");
  res.status(200).json({
    ok: true,
    webhook_info: webhookInfo
  });
};
