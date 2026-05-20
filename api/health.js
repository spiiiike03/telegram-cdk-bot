const { config } = require("../src/config");
const { query } = require("../src/db");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    await query("SELECT 1");
    res.status(200).json({
      ok: true,
      database: "ok",
      channel: config.channelId || config.channelUsername,
      invite_target: config.inviteTarget,
      max_rewards_per_inviter: config.maxRewardsPerInviter
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: "error",
      error: error.message
    });
  }
};
