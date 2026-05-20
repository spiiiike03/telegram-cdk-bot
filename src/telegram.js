const { config } = require("./config");

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = data.description || response.statusText;
    const error = new Error(`Telegram ${method} failed: ${description}`);
    error.telegram = data;
    throw error;
  }

  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra
  });
}

async function createInviteLink(userId) {
  const name = `ref-${userId}`.slice(0, 32);
  return telegram("createChatInviteLink", {
    chat_id: config.channelId || config.channelUsername,
    name,
    creates_join_request: false
  });
}

async function notifyAdmins(text) {
  const admins = [...config.adminIds];
  await Promise.allSettled(admins.map((adminId) => sendMessage(adminId, text)));
}

module.exports = {
  telegram,
  sendMessage,
  createInviteLink,
  notifyAdmins
};
