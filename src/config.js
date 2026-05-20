require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseAdmins(raw) {
  return new Set(
    (raw || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function normalizeUsername(value) {
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.toLowerCase() : `@${trimmed.toLowerCase()}`;
}

const config = {
  botToken: required("BOT_TOKEN"),
  botUsername: (process.env.BOT_USERNAME || "").replace(/^@/, ""),
  channelUsername: normalizeUsername(process.env.CHANNEL_USERNAME || "@spiiiike03"),
  channelId: process.env.CHANNEL_ID ? String(process.env.CHANNEL_ID).trim() : "",
  publicChannelUrl: process.env.PUBLIC_CHANNEL_URL || "https://t.me/spiiiike03",
  databaseUrl: required("DATABASE_URL"),
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  setupSecret: process.env.SETUP_SECRET || "",
  adminIds: parseAdmins(process.env.ADMIN_IDS),
  inviteTarget: optionalInt("INVITE_TARGET", 5),
  maxRewardsPerInviter: optionalInt("MAX_REWARDS_PER_INVITER", 50)
};

module.exports = {
  config,
  normalizeUsername
};
