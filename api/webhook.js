const { config } = require("../src/config");
const { handleUpdate } = require("../src/bot");

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "telegram-cdk-bot" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (config.webhookSecret) {
    const header = req.headers["x-telegram-bot-api-secret-token"];
    if (header !== config.webhookSecret) {
      res.status(401).json({ ok: false, error: "Invalid Telegram secret token" });
      return;
    }
  }

  let update;
  try {
    update = await readJson(req);
  } catch (error) {
    res.status(400).json({ ok: false, error: "Invalid JSON" });
    return;
  }

  await handleUpdate(update);
  res.status(200).json({ ok: true });
};
