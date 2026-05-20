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

  const me = await telegram("getMe");
  const chat = await telegram("getChat", {
    chat_id: config.channelId || config.channelUsername
  });
  const member = await telegram("getChatMember", {
    chat_id: chat.id,
    user_id: me.id
  });

  res.status(200).json({
    ok: true,
    bot: {
      id: me.id,
      username: me.username,
      can_join_groups: me.can_join_groups,
      can_read_all_group_messages: me.can_read_all_group_messages,
      supports_inline_queries: me.supports_inline_queries
    },
    channel: {
      id: chat.id,
      title: chat.title,
      username: chat.username,
      type: chat.type
    },
    bot_channel_member: {
      status: member.status,
      can_invite_users: Boolean(member.can_invite_users),
      can_manage_chat: Boolean(member.can_manage_chat),
      can_post_messages: Boolean(member.can_post_messages),
      can_edit_messages: Boolean(member.can_edit_messages),
      can_delete_messages: Boolean(member.can_delete_messages)
    }
  });
};
