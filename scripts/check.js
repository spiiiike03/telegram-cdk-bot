const { config } = require("../src/config");
const { telegram } = require("../src/telegram");

async function main() {
  const me = await telegram("getMe");
  console.log(`Bot: @${me.username} (${me.id})`);

  const chat = await telegram("getChat", {
    chat_id: config.channelId || config.channelUsername
  });
  console.log(`Channel: ${chat.title || chat.username || chat.id} (${chat.id})`);

  const member = await telegram("getChatMember", {
    chat_id: chat.id,
    user_id: me.id
  });
  console.log(`Bot channel status: ${member.status}`);
  console.log(`can_invite_users: ${Boolean(member.can_invite_users)}`);
  console.log(`can_manage_chat: ${Boolean(member.can_manage_chat)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
