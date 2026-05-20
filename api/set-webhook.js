const { config } = require("../src/config");
const { telegram } = require("../src/telegram");

function requireSetupSecret(req, res) {
  if (!config.setupSecret) {
    res.status(500).json({ ok: false, error: "SETUP_SECRET is not configured" });
    return false;
  }

  if (req.headers["x-setup-secret"] !== config.setupSecret) {
    res.status(401).json({ ok: false, error: "Invalid setup secret" });
    return false;
  }

  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!requireSetupSecret(req, res)) return;

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const webhookUrl = `${proto}://${host}/api/webhook`;

  await telegram("setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "chat_member"],
    secret_token: config.webhookSecret || undefined,
    drop_pending_updates: true
  });

  const webhookInfo = await telegram("getWebhookInfo");
  res.status(200).json({
    ok: true,
    webhook_url: webhookUrl,
    webhook_info: webhookInfo
  });
};
