const { config } = require("../src/config");
const { telegram } = require("../src/telegram");

async function main() {
  const url = process.env.WEBHOOK_URL;
  if (!url) {
    throw new Error("WEBHOOK_URL is required, for example https://your-project.vercel.app/api/webhook");
  }

  const result = await telegram("setWebhook", {
    url,
    allowed_updates: ["message", "chat_member"],
    secret_token: config.webhookSecret || undefined,
    drop_pending_updates: true
  });

  console.log("Webhook set:", result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
