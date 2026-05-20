const { telegram } = require("../src/telegram");

async function main() {
  const result = await telegram("getWebhookInfo");
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
