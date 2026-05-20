const { telegram } = require("../src/telegram");

async function main() {
  const result = await telegram("deleteWebhook", {
    drop_pending_updates: false
  });

  console.log("Webhook deleted:", result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
