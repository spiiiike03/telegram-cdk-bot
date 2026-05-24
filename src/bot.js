const { config, normalizeUsername } = require("./config");
const { query, transaction } = require("./db");
const { createInviteLink, notifyAdmins, sendMessage, telegram } = require("./telegram");

const ACTIVE_STATUSES = new Set(["creator", "administrator", "member"]);
const TEN_INVITE_BONUS_KEY = "ten_invites";
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

function bonusKeyForTier(tier) {
  return tier === 1 ? TEN_INVITE_BONUS_KEY : `${TEN_INVITE_BONUS_KEY}_${tier}`;
}

function userId(user) {
  return String(user.id);
}

function username(user) {
  return user.username ? `@${user.username}` : null;
}

function displayName(user) {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return username(user) || parts.join(" ") || userId(user);
}

function displayDbName(row, idField = "user_id") {
  const parts = [row.first_name, row.last_name].filter(Boolean);
  return row.username || parts.join(" ") || String(row[idField]);
}

function displayPrefixedName(row, prefix, idField) {
  const parts = [row[`${prefix}_first_name`], row[`${prefix}_last_name`]].filter(Boolean);
  return row[`${prefix}_username`] || parts.join(" ") || String(row[idField] || "-");
}

function isPostgresBigint(value) {
  if (!/^\d+$/.test(value)) return false;

  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX;
  } catch {
    return false;
  }
}

function isTelegramUsernameTarget(value) {
  return /^@[A-Za-z0-9_]{5,32}$/.test(value);
}

function normalizeTelegramUsernameTarget(value) {
  if (!/^@?[A-Za-z0-9_]{5,32}$/.test(value)) return null;
  return value.startsWith("@") ? value : `@${value}`;
}

function commandBody(text, commandName) {
  return text.replace(new RegExp(`^\\/${commandName}(?:@\\w+)?`, "i"), "").trim();
}

function parseTargetCommand(text, commandName) {
  const body = commandBody(text, commandName);
  const [target = "", ...rest] = body.split(/\s+/).filter(Boolean);
  return {
    target,
    rest: rest.join(" ").trim()
  };
}

function formatDate(value) {
  if (!value) return "-";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.reportTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function formatReportDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.reportTimezone,
    month: "numeric",
    day: "numeric"
  }).formatToParts(date);
  const month = parts.find((part) => part.type === "month").value;
  const day = parts.find((part) => part.type === "day").value;
  return `${month}月${day}日`;
}

function isAdmin(user) {
  return config.adminIds.has(userId(user));
}

function isActiveMember(member) {
  if (!member) return false;
  if (ACTIVE_STATUSES.has(member.status)) return true;
  return member.status === "restricted" && member.is_member === true;
}

function isTargetChat(chat) {
  if (config.channelId && String(chat.id) === config.channelId) return true;
  if (config.channelUsername && chat.username) {
    return normalizeUsername(chat.username) === config.channelUsername;
  }
  return false;
}

async function upsertInviter(user, inviteLink = null) {
  await query(
    `
      INSERT INTO inviters (
        user_id, username, first_name, last_name, invite_link, invite_link_name, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        invite_link = COALESCE(inviters.invite_link, EXCLUDED.invite_link),
        invite_link_name = COALESCE(inviters.invite_link_name, EXCLUDED.invite_link_name),
        updated_at = NOW()
    `,
    [
      userId(user),
      username(user),
      user.first_name || null,
      user.last_name || null,
      inviteLink ? inviteLink.invite_link : null,
      inviteLink ? inviteLink.name : null
    ]
  );
}

async function getOrCreateInviteLink(user) {
  const id = userId(user);
  await upsertInviter(user);

  const existing = await query("SELECT invite_link FROM inviters WHERE user_id = $1", [id]);
  if (existing.rows[0] && existing.rows[0].invite_link) {
    return existing.rows[0].invite_link;
  }

  const inviteLink = await createInviteLink(id);
  await upsertInviter(user, inviteLink);
  return inviteLink.invite_link;
}

async function getInviterByLink(inviteLink) {
  const result = await query("SELECT * FROM inviters WHERE invite_link = $1", [inviteLink]);
  return result.rows[0] || null;
}

let rewardBlacklistTableReady = false;

async function ensureRewardBlacklistTable() {
  if (rewardBlacklistTableReady) return;

  await query(`
    CREATE TABLE IF NOT EXISTS reward_blacklist (
      user_id BIGINT PRIMARY KEY,
      reason TEXT,
      created_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_notified_at TIMESTAMPTZ
    )
  `);
  rewardBlacklistTableReady = true;
}

async function getBlacklistEntry(inviterId) {
  await ensureRewardBlacklistTable();
  const result = await query(
    "SELECT user_id::text AS user_id, reason, created_at, last_notified_at FROM reward_blacklist WHERE user_id = $1",
    [inviterId]
  );
  return result.rows[0] || null;
}

function blacklistNoticeText(entry = {}) {
  return [
    "你已被拉黑，无法获得邀请奖励。",
    entry.reason ? `原因：${entry.reason}` : null,
    "如有疑问请联系管理员。"
  ].filter(Boolean).join("\n");
}

async function notifyBlacklistedUser(inviterId, entry) {
  await sendMessage(inviterId, blacklistNoticeText(entry)).catch(() => null);
  await ensureRewardBlacklistTable();
  await query("UPDATE reward_blacklist SET last_notified_at = NOW() WHERE user_id = $1", [inviterId]);
}

async function markPendingRewardsBlacklisted(inviterId) {
  await query(
    "UPDATE rewards SET delivery_error = $2 WHERE inviter_id = $1 AND cdk_id IS NULL",
    [inviterId, "BLACKLISTED"]
  );
  await query(
    "UPDATE bonus_rewards SET delivery_error = $2 WHERE inviter_id = $1 AND cdk_id IS NULL",
    [inviterId, "BLACKLISTED"]
  );
}

async function suppressBlacklistedRewards(inviterId) {
  const stats = await getStats(inviterId);
  const regularEligibleRewards = Math.floor(stats.activeCount / config.inviteTarget);
  const shouldHaveRewards = config.maxRewardsPerInviter === 0
    ? regularEligibleRewards
    : Math.min(regularEligibleRewards, config.maxRewardsPerInviter);

  for (let rewardNumber = stats.totalRewards + 1; rewardNumber <= shouldHaveRewards; rewardNumber += 1) {
    await query(
      `
        INSERT INTO rewards (
          inviter_id, reward_number, active_count_at_award, cdk_id, delivery_error
        )
        VALUES ($1, $2, $3, NULL, 'BLACKLISTED')
        ON CONFLICT (inviter_id, reward_number) DO NOTHING
      `,
      [inviterId, rewardNumber, stats.activeCount]
    );
  }

  const bonusEligibleRewards = Math.floor(stats.activeCount / config.tenInviteBonusThreshold);
  for (let bonusNumber = stats.bonusTotalRewards + 1; bonusNumber <= bonusEligibleRewards; bonusNumber += 1) {
    await query(
      `
        INSERT INTO bonus_rewards (
          inviter_id, bonus_key, threshold, active_count_at_award, cdk_id, delivery_error
        )
        VALUES ($1, $2, $3, $4, NULL, 'BLACKLISTED')
        ON CONFLICT (inviter_id, bonus_key) DO NOTHING
      `,
      [
        inviterId,
        bonusKeyForTier(bonusNumber),
        bonusNumber * config.tenInviteBonusThreshold,
        stats.activeCount
      ]
    );
  }
}

async function getStats(inviterId) {
  const blacklist = await getBlacklistEntry(inviterId);
  const active = await query(
    "SELECT COUNT(*)::int AS count FROM referrals WHERE inviter_id = $1 AND active = TRUE",
    [inviterId]
  );
  const inactive = await query(
    "SELECT COUNT(*)::int AS count FROM referrals WHERE inviter_id = $1 AND active = FALSE",
    [inviterId]
  );
  const rewards = await query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(cdk_id)::int AS delivered,
        COUNT(*) FILTER (
          WHERE cdk_id IS NULL
            AND COALESCE(delivery_error, '') <> 'BLACKLISTED'
        )::int AS pending
      FROM rewards
      WHERE inviter_id = $1
    `,
    [inviterId]
  );
  const bonusRewards = await query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(cdk_id)::int AS delivered,
        COUNT(*) FILTER (
          WHERE cdk_id IS NULL
            AND COALESCE(delivery_error, '') <> 'BLACKLISTED'
        )::int AS pending
      FROM bonus_rewards
      WHERE inviter_id = $1
    `,
    [inviterId]
  );

  const activeCount = active.rows[0].count;
  const inactiveCount = inactive.rows[0].count;
  const totalRewards = rewards.rows[0].total;
  const regularDeliveredRewards = rewards.rows[0].delivered;
  const regularPendingRewards = rewards.rows[0].pending;
  const bonusTotalRewards = bonusRewards.rows[0].total;
  const bonusDeliveredRewards = bonusRewards.rows[0].delivered;
  const bonusPendingRewards = bonusRewards.rows[0].pending;
  const deliveredRewards = regularDeliveredRewards + bonusDeliveredRewards;
  const pendingRewards = regularPendingRewards + bonusPendingRewards;
  const unlimitedRewards = config.maxRewardsPerInviter === 0;
  const regularEligibleRewards = Math.floor(activeCount / config.inviteTarget);
  const bonusEligibleRewards = Math.floor(activeCount / config.tenInviteBonusThreshold);
  const eligibleRewards = unlimitedRewards
    ? regularEligibleRewards
    : Math.min(regularEligibleRewards, config.maxRewardsPerInviter);
  const nextAt = (totalRewards + 1) * config.inviteTarget;
  const needed = !unlimitedRewards && totalRewards >= config.maxRewardsPerInviter
    ? 0
    : Math.max(0, nextAt - activeCount);
  const nextBonusAt = (bonusTotalRewards + 1) * config.tenInviteBonusThreshold;
  const bonusNeeded = Math.max(0, nextBonusAt - activeCount);

  return {
    activeCount,
    inactiveCount,
    blacklisted: Boolean(blacklist),
    blacklistReason: blacklist ? blacklist.reason : null,
    totalRewards,
    regularDeliveredRewards,
    regularPendingRewards,
    bonusTotalRewards,
    bonusDeliveredRewards,
    bonusPendingRewards,
    bonusEligibleRewards,
    deliveredRewards,
    pendingRewards,
    eligibleRewards,
    unlimitedRewards,
    needed,
    bonusNeeded
  };
}

function statsText(link, stats) {
  const blacklistNotice = stats.blacklisted
    ? [
        blacklistNoticeText({ reason: stats.blacklistReason }),
        ""
      ].join("\n")
    : null;
  const staleRewardNotice = stats.activeCount < stats.regularDeliveredRewards
    ? [
        "有效邀请小于已发放 CDK",
        "",
        `有效邀请：${stats.activeCount}｜已失效：${stats.inactiveCount}｜已发常规 CDK：${stats.regularDeliveredRewards}`,
        `下次发放还差：${stats.needed} 人`,
        "",
        "说明：退频道的邀请会失效，不计入后续奖励。需补回有效邀请数并超过已发 CDK 数后，才会继续发放。",
        ""
      ].join("\n")
    : null;
  const bonusPendingText = stats.bonusPendingRewards > 0
    ? `，待补发 ${stats.bonusPendingRewards} 个`
    : "";
  const bonusText = stats.bonusTotalRewards > 0
    ? `每满 ${config.tenInviteBonusThreshold} 人额外奖励：已达成 ${stats.bonusTotalRewards} 次，已发放 ${stats.bonusDeliveredRewards} 个 CDK${bonusPendingText}`
    : stats.bonusPendingRewards > 0
      ? `每满 ${config.tenInviteBonusThreshold} 人额外奖励：已达成，待补发`
      : `每满 ${config.tenInviteBonusThreshold} 人额外奖励：还差 ${stats.bonusNeeded} 人`;

  return [
    blacklistNotice,
    staleRewardNotice,
    link ? "你的专属邀请链接：" : null,
    link,
    "",
    `有效邀请：${stats.activeCount}`,
    `已发放 CDK：${stats.deliveredRewards}`,
    stats.unlimitedRewards
      ? `常规奖励：${stats.regularDeliveredRewards}（无上限）`
      : `常规奖励：${stats.regularDeliveredRewards}/${config.maxRewardsPerInviter}`,
    bonusText,
    stats.pendingRewards > 0 ? `待补发 CDK：${stats.pendingRewards}` : null,
    !stats.unlimitedRewards && stats.totalRewards >= config.maxRewardsPerInviter
      ? "你已达到最高奖励次数。"
      : `距离下一个 CDK 还差：${stats.needed} 人`,
    "",
    "只有通过上面的专属链接加入频道的新用户才会计入。"
  ].filter(Boolean).join("\n");
}

async function sendUserStats(user, chatId) {
  const id = userId(user);
  await upsertInviter(user);
  const link = await getOrCreateInviteLink(user);

  let stats = await getStats(id);
  if (stats.blacklisted) {
    await sendMessage(chatId, statsText(link, stats));
    return;
  }

  await awardRewards(id);
  stats = await getStats(id);
  await sendMessage(chatId, statsText(link, stats));
}

async function addCdks(text, adminId) {
  const codes = text
    .replace(/^\/addcdk(?:@\w+)?/i, "")
    .split(/\s+/)
    .map((code) => code.trim())
    .filter(Boolean);

  if (codes.length === 0) {
    await sendMessage(adminId, "用法：/addcdk CODE1 CODE2 CODE3，也可以换行粘贴多个 CDK。");
    return;
  }

  const batch = `admin-${adminId}-${Date.now()}`;
  let inserted = 0;
  for (const code of codes) {
    const result = await query(
      "INSERT INTO cdks (code, batch) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING",
      [code, batch]
    );
    inserted += result.rowCount;
  }

  await sendMessage(adminId, `已导入 ${inserted} 个 CDK，重复跳过 ${codes.length - inserted} 个。`);
  await fulfillAllPendingRewards();
}

async function sendInventory(chatId) {
  const result = await query(
    `
      SELECT
        COUNT(*) FILTER (WHERE used_by IS NULL)::int AS unused,
        COUNT(*) FILTER (WHERE used_by IS NOT NULL)::int AS used,
        (
          (SELECT COUNT(*)::int FROM rewards WHERE cdk_id IS NULL AND COALESCE(delivery_error, '') <> 'BLACKLISTED') +
          (SELECT COUNT(*)::int FROM bonus_rewards WHERE cdk_id IS NULL AND COALESCE(delivery_error, '') <> 'BLACKLISTED')
        ) AS pending
      FROM cdks
    `
  );
  const row = result.rows[0];
  await sendMessage(chatId, `CDK 库存：${row.unused}\n已使用：${row.used}\n待补发：${row.pending}`);
}

async function getLeaderboardExcludedIds() {
  const excluded = new Set(config.adminIds);

  try {
    const admins = await telegram("getChatAdministrators", {
      chat_id: config.channelId || config.channelUsername
    });

    for (const admin of admins) {
      if (admin.user && admin.user.id) {
        excluded.add(String(admin.user.id));
      }
    }
  } catch (_) {
    // Keep leaderboard usable even if Telegram refuses the admin list.
  }

  return [...excluded];
}

async function sendAdminStats(chatId) {
  await ensureRewardBlacklistTable();
  const result = await query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM inviters) AS inviters,
        (SELECT COUNT(*)::int FROM referrals) AS total_referrals,
        (SELECT COUNT(*)::int FROM referrals WHERE active = TRUE) AS active_referrals,
        (SELECT COUNT(*)::int FROM referrals WHERE active = FALSE) AS inactive_referrals,
        (SELECT COUNT(*)::int FROM channel_members WHERE active = TRUE) AS active_channel_members,
        (SELECT COUNT(*)::int FROM reward_blacklist) AS blacklisted_users,
        (SELECT COUNT(*)::int FROM cdks WHERE used_by IS NULL) AS unused_cdks,
        (SELECT COUNT(*)::int FROM cdks WHERE used_by IS NOT NULL) AS used_cdks,
        (SELECT COUNT(*)::int FROM rewards) AS regular_rewards,
        (SELECT COUNT(*)::int FROM bonus_rewards) AS bonus_rewards,
        (
          (SELECT COUNT(*)::int FROM rewards) +
          (SELECT COUNT(*)::int FROM bonus_rewards)
        ) AS total_rewards,
        (
          (SELECT COUNT(*)::int FROM rewards WHERE cdk_id IS NOT NULL) +
          (SELECT COUNT(*)::int FROM bonus_rewards WHERE cdk_id IS NOT NULL)
        ) AS delivered_rewards,
        (
          (SELECT COUNT(*)::int FROM rewards WHERE cdk_id IS NULL AND COALESCE(delivery_error, '') <> 'BLACKLISTED') +
          (SELECT COUNT(*)::int FROM bonus_rewards WHERE cdk_id IS NULL AND COALESCE(delivery_error, '') <> 'BLACKLISTED')
        ) AS pending_rewards
    `
  );

  const row = result.rows[0];
  await sendMessage(
    chatId,
    [
      "后台总览",
      `邀请人：${row.inviters}`,
      `邀请记录：${row.total_referrals}`,
      `有效邀请：${row.active_referrals}`,
      `已退/失效：${row.inactive_referrals}`,
      `当前频道成员记录：${row.active_channel_members}`,
      `黑名单用户：${row.blacklisted_users}`,
      "",
      `CDK 库存：${row.unused_cdks}`,
      `CDK 已用：${row.used_cdks}`,
      `奖励记录：${row.total_rewards}`,
      `常规奖励：${row.regular_rewards}`,
      `每满 ${config.tenInviteBonusThreshold} 人额外奖励：${row.bonus_rewards}`,
      `已发奖励：${row.delivered_rewards}`,
      `待补发奖励：${row.pending_rewards}`
    ].join("\n")
  );
}

async function sendTopInviters(chatId) {
  await ensureRewardBlacklistTable();
  const excludedIds = await getLeaderboardExcludedIds();
  const result = await query(
    `
      WITH bounds AS (
        SELECT
          (date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2) AS start_at,
          ((date_trunc('day', NOW() AT TIME ZONE $2) + INTERVAL '1 day') AT TIME ZONE $2) AS end_at
      )
      SELECT
        i.user_id::text AS user_id,
        i.username,
        i.first_name,
        i.last_name,
        COUNT(*)::int AS invite_count
      FROM bounds
      JOIN referrals r ON
        r.active = TRUE
        AND r.joined_at >= bounds.start_at
        AND r.joined_at < bounds.end_at
      JOIN inviters i ON i.user_id = r.inviter_id
      LEFT JOIN reward_blacklist b ON b.user_id = i.user_id
      WHERE b.user_id IS NULL AND NOT (i.user_id = ANY($1::bigint[]))
      GROUP BY i.user_id, i.username, i.first_name, i.last_name
      HAVING COUNT(*) > 0
      ORDER BY invite_count DESC, i.user_id ASC
      LIMIT 5
    `,
    [excludedIds, config.reportTimezone]
  );

  if (result.rows.length === 0) {
    await sendMessage(chatId, `🏆 邀请排行榜 TOP 5（${formatReportDate()}实时更新）\n暂无有效邀请。`);
    return;
  }

  const rankIcons = ["🥇", "🥈", "🥉"];
  const lines = [`🏆 邀请排行榜 TOP 5（${formatReportDate()}实时更新）`];
  result.rows.forEach((row, index) => {
    const rank = rankIcons[index] || `${index + 1}.`;
    lines.push(
      `${rank} ${displayDbName(row)} 邀请${row.invite_count}人`
    );
  });

  await sendMessage(chatId, lines.join("\n"));
}

async function sendInviterDetail(chatId, text) {
  const target = text
    .replace(/^\/user(?:@\w+)?/i, "")
    .trim();

  if (!target) {
    await sendMessage(chatId, "用法：/user 123456789 或 /user @username");
    return;
  }

  let result;
  if (isTelegramUsernameTarget(target)) {
    result = await query("SELECT * FROM inviters WHERE lower(username) = lower($1)", [target]);
  } else if (isPostgresBigint(target)) {
    result = await query("SELECT * FROM inviters WHERE user_id = $1", [target]);
  } else {
    await sendMessage(chatId, "用法：/user 123456789 或 /user @username\n不能直接用昵称查询。");
    return;
  }

  const inviter = result.rows[0];
  if (!inviter) {
    await sendMessage(chatId, "没有找到这个邀请人。");
    return;
  }

  const stats = await getStats(String(inviter.user_id));
  const total = await query(
    "SELECT COUNT(*)::int AS count FROM referrals WHERE inviter_id = $1",
    [inviter.user_id]
  );
  const referrals = await query(
    `
      SELECT
        invited_user_id::text AS invited_user_id,
        invited_username AS username,
        invited_first_name AS first_name,
        invited_last_name AS last_name,
        active,
        joined_at,
        left_at
      FROM referrals
      WHERE inviter_id = $1
      ORDER BY joined_at DESC
      LIMIT 20
    `,
    [inviter.user_id]
  );

  const lines = [
    `邀请人：${displayDbName(inviter)}`,
    `ID：${inviter.user_id}`,
    inviter.invite_link ? `邀请链接：${inviter.invite_link}` : "邀请链接：未生成",
    stats.blacklisted ? `黑名单：是${stats.blacklistReason ? `，原因：${stats.blacklistReason}` : ""}` : "黑名单：否",
    "",
    `有效邀请：${stats.activeCount}`,
    `总邀请记录：${total.rows[0].count}`,
    `已发 CDK：${stats.deliveredRewards}`,
    stats.bonusTotalRewards > 0
      ? `每满 ${config.tenInviteBonusThreshold} 人额外奖励：已达成 ${stats.bonusTotalRewards} 次，已发放 ${stats.bonusDeliveredRewards} 次${stats.bonusPendingRewards > 0 ? `，待补发 ${stats.bonusPendingRewards} 次` : ""}`
      : stats.bonusPendingRewards > 0
        ? `每满 ${config.tenInviteBonusThreshold} 人额外奖励：待补发`
        : `每满 ${config.tenInviteBonusThreshold} 人额外奖励：还差 ${stats.bonusNeeded} 人`,
    `待补发 CDK：${stats.pendingRewards}`,
    ""
  ];

  if (referrals.rows.length === 0) {
    lines.push("被邀请人：暂无");
  } else {
    lines.push("被邀请人（最近 20 条）：");
    referrals.rows.forEach((row, index) => {
      const status = row.active ? "有效" : "已退";
      const left = row.left_at ? `，退：${formatDate(row.left_at)}` : "";
      lines.push(
        `${index + 1}. ${displayDbName(row, "invited_user_id")} (${row.invited_user_id}) ${status}，进：${formatDate(row.joined_at)}${left}`
      );
    });
  }

  await sendMessage(chatId, lines.join("\n"));
}

async function sendInvitedDetail(chatId, text, commandName = "invited") {
  const { target } = parseTargetCommand(text, commandName);
  if (!target) {
    await sendMessage(chatId, `用法：/${commandName} 123456789 或 /${commandName} @username`);
    return;
  }

  const usernameTarget = normalizeTelegramUsernameTarget(target);
  const isNumericTarget = isPostgresBigint(target);
  if (!usernameTarget && !isNumericTarget) {
    await sendMessage(chatId, `用法：/${commandName} 123456789 或 /${commandName} @username`);
    return;
  }

  const memberCondition = isNumericTarget
    ? "c.user_id = $1"
    : "lower(c.username) = lower($1)";
  const referralCondition = isNumericTarget
    ? "r.invited_user_id = $1"
    : "lower(r.invited_username) = lower($1)";
  const lookupValue = isNumericTarget ? target : usernameTarget;

  const memberResult = await query(
    `
      SELECT
        c.user_id::text AS user_id,
        c.username,
        c.first_name,
        c.last_name,
        c.first_seen_at,
        c.joined_at,
        c.left_at,
        c.active,
        c.last_status,
        c.first_inviter_id::text AS first_inviter_id,
        c.first_invite_link,
        i.username AS inviter_username,
        i.first_name AS inviter_first_name,
        i.last_name AS inviter_last_name,
        i.invite_link AS inviter_current_link
      FROM channel_members c
      LEFT JOIN inviters i ON i.user_id = c.first_inviter_id
      WHERE ${memberCondition}
      ORDER BY c.updated_at DESC
      LIMIT 1
    `,
    [lookupValue]
  );

  const referralResult = await query(
    `
      SELECT
        r.invited_user_id::text AS user_id,
        r.invited_username AS username,
        r.invited_first_name AS first_name,
        r.invited_last_name AS last_name,
        r.inviter_id::text AS inviter_id,
        r.invite_link,
        r.joined_at,
        r.left_at,
        r.active,
        r.last_status,
        i.username AS inviter_username,
        i.first_name AS inviter_first_name,
        i.last_name AS inviter_last_name,
        i.invite_link AS inviter_current_link
      FROM referrals r
      LEFT JOIN inviters i ON i.user_id = r.inviter_id
      WHERE ${referralCondition}
      ORDER BY r.joined_at DESC
      LIMIT 1
    `,
    [lookupValue]
  );

  const member = memberResult.rows[0] || null;
  const referral = referralResult.rows[0] || null;
  const user = referral || member;

  if (!user) {
    await sendMessage(chatId, "没有找到这个被邀请人记录。可能他没有进过频道，或进频道时没有被 bot 记录到。");
    return;
  }

  const inviterId = referral ? referral.inviter_id : member.first_inviter_id;
  const inviterName = referral
    ? displayPrefixedName(referral, "inviter", "inviter_id")
    : displayPrefixedName(member, "inviter", "first_inviter_id");
  const inviteLink = referral ? referral.invite_link : member.first_invite_link;
  const active = referral ? referral.active : member.active;
  const joinedAt = referral ? referral.joined_at : member.joined_at;
  const leftAt = referral ? referral.left_at : member.left_at;
  const lastStatus = referral ? referral.last_status : member.last_status;
  const countedText = referral
    ? (referral.active ? "是，当前有效" : "曾计入，现已失效")
    : "否";

  const lines = [
    `被邀请人：${displayDbName(user)}`,
    `ID：${user.user_id}`,
    `当前频道状态：${active ? "在频道" : "已退/不在频道"}`,
    `进入时间：${formatDate(joinedAt)}`,
    leftAt ? `退出时间：${formatDate(leftAt)}` : null,
    lastStatus ? `最后状态：${lastStatus}` : null,
    "",
    inviterId ? `邀请人：${inviterName} (${inviterId})` : "邀请人：无记录",
    inviteLink ? `邀请链接：${inviteLink}` : "邀请链接：无记录",
    `是否计入邀请奖励：${countedText}`,
    member && member.first_seen_at ? `首次记录时间：${formatDate(member.first_seen_at)}` : null,
    !inviterId ? "说明：通常是公开链接、频道搜索或未带专属邀请链接进入。" : null
  ].filter(Boolean);

  await sendMessage(chatId, lines.join("\n"));
}

async function resolveUserTarget(target) {
  if (isTelegramUsernameTarget(target)) {
    const result = await query("SELECT * FROM inviters WHERE lower(username) = lower($1)", [target]);
    const inviter = result.rows[0];
    if (!inviter) {
      return { error: "没有找到这个用户名，请改用 Telegram 数字 user id。" };
    }
    return { userId: String(inviter.user_id), inviter };
  }

  if (isPostgresBigint(target)) {
    const result = await query("SELECT * FROM inviters WHERE user_id = $1", [target]);
    return { userId: target, inviter: result.rows[0] || null };
  }

  return { error: "用法：/blacklist 123456789 原因 或 /blacklist @username 原因" };
}

async function blacklistUser(chatId, text, adminId) {
  await ensureRewardBlacklistTable();
  const { target, rest: reason } = parseTargetCommand(text, "blacklist");
  if (!target) {
    await sendMessage(chatId, "用法：/blacklist 123456789 原因 或 /blacklist @username 原因");
    return;
  }

  const resolved = await resolveUserTarget(target);
  if (resolved.error) {
    await sendMessage(chatId, resolved.error);
    return;
  }

  await query(
    `
      INSERT INTO reward_blacklist (user_id, reason, created_by, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        reason = EXCLUDED.reason,
        created_by = EXCLUDED.created_by,
        updated_at = NOW()
    `,
    [resolved.userId, reason || null, adminId]
  );
  await markPendingRewardsBlacklisted(resolved.userId);
  await suppressBlacklistedRewards(resolved.userId);
  await notifyBlacklistedUser(resolved.userId, { reason: reason || null });

  await sendMessage(
    chatId,
    [
      `已拉黑：${resolved.inviter ? displayDbName(resolved.inviter) : resolved.userId}`,
      `ID：${resolved.userId}`,
      reason ? `原因：${reason}` : null,
      "该用户将不能再获得邀请奖励。"
    ].filter(Boolean).join("\n")
  );
}

async function unblacklistUser(chatId, text) {
  await ensureRewardBlacklistTable();
  const { target } = parseTargetCommand(text, "unblacklist");
  if (!target) {
    await sendMessage(chatId, "用法：/unblacklist 123456789 或 /unblacklist @username");
    return;
  }

  const resolved = await resolveUserTarget(target);
  if (resolved.error) {
    await sendMessage(chatId, resolved.error.replace("/blacklist", "/unblacklist"));
    return;
  }

  const result = await query(
    "DELETE FROM reward_blacklist WHERE user_id = $1 RETURNING user_id",
    [resolved.userId]
  );

  if (result.rows.length === 0) {
    await sendMessage(chatId, "该用户不在黑名单中。");
    return;
  }

  await sendMessage(resolved.userId, "你的邀请奖励限制已解除，可以继续获得邀请奖励。").catch(() => null);
  await sendMessage(
    chatId,
    [
      `已解除拉黑：${resolved.inviter ? displayDbName(resolved.inviter) : resolved.userId}`,
      `ID：${resolved.userId}`
    ].join("\n")
  );
}

async function sendBlacklist(chatId) {
  await ensureRewardBlacklistTable();
  const result = await query(
    `
      SELECT
        b.user_id::text AS user_id,
        b.reason,
        b.created_at,
        i.username,
        i.first_name,
        i.last_name
      FROM reward_blacklist b
      LEFT JOIN inviters i ON i.user_id = b.user_id
      ORDER BY b.created_at DESC
      LIMIT 30
    `
  );

  if (result.rows.length === 0) {
    await sendMessage(chatId, "黑名单为空。");
    return;
  }

  const lines = ["黑名单（最近 30 条）："];
  result.rows.forEach((row, index) => {
    lines.push(
      `${index + 1}. ${displayDbName(row)} (${row.user_id})${row.reason ? `，原因：${row.reason}` : ""}`
    );
  });
  await sendMessage(chatId, lines.join("\n"));
}

async function sendAdminHelp(chatId) {
  await sendMessage(
    chatId,
    [
      "管理员命令",
      "/inventory - 查看 CDK 库存",
      "/stats - 查看后台总览",
      "/top - 查看今日有效邀请 TOP 5",
      "/user 123456789 - 查看邀请人和被邀请人明细",
      "/invited 123456789 - 查看被邀请人从哪条链接进入",
      "/blacklist 123456789 原因 - 拉黑用户，停止发奖",
      "/unblacklist 123456789 - 解除拉黑",
      "/blacklistlist - 查看黑名单",
      "/syncrewards - 同步已达标但未发放的奖励",
      "/addcdk CODE1 CODE2 - 导入 CDK"
    ].join("\n")
  );
}

async function handleMessage(message) {
  if (!message.from || message.chat.type !== "private") return;

  const text = message.text || "";
  const command = text.trim().split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();

  if (command === "/start" || command === "/link" || command === "/status") {
    await sendUserStats(message.from, message.chat.id);
    return;
  }

  if (command === "/id" || command === "/whoami") {
    await sendMessage(message.chat.id, `你的 Telegram user id：${userId(message.from)}`);
    return;
  }

  if (command === "/addcdk") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await addCdks(text, userId(message.from));
    return;
  }

  if (command === "/inventory") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await sendInventory(message.chat.id);
    return;
  }

  if (command === "/admin") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await sendAdminHelp(message.chat.id);
    return;
  }

  if (command === "/stats") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await sendAdminStats(message.chat.id);
    return;
  }

  if (command === "/top" || command === "/rank") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await sendTopInviters(message.chat.id);
    return;
  }

  if (command === "/user") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await sendInviterDetail(message.chat.id, text);
    return;
  }

  if (command === "/invited" || command === "/member") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await sendInvitedDetail(message.chat.id, text, command.slice(1));
    return;
  }

  if (command === "/blacklist") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await blacklistUser(message.chat.id, text, userId(message.from));
    return;
  }

  if (command === "/unblacklist") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await unblacklistUser(message.chat.id, text);
    return;
  }

  if (command === "/blacklistlist") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    await sendBlacklist(message.chat.id);
    return;
  }

  if (command === "/syncrewards") {
    if (!isAdmin(message.from)) {
      await sendMessage(message.chat.id, "没有权限。");
      return;
    }
    const count = await syncEligibleRewards();
    await sendMessage(message.chat.id, `奖励同步完成，已检查 ${count} 个符合奖励门槛的邀请人。`);
    return;
  }

  await sendMessage(
    message.chat.id,
    "可用命令：/link 获取邀请链接，/status 查看进度，/id 查看你的 user id。"
  );
}

async function recordMemberJoin(memberUpdate, inviter = null) {
  const invited = memberUpdate.new_chat_member.user;
  const invitedId = userId(invited);
  let inviterId = inviter ? String(inviter.user_id) : null;

  if (invitedId === inviterId) return;

  let awardInviterId = null;

  await transaction(async (client) => {
    const existingMember = await client.query(
      "SELECT user_id FROM channel_members WHERE user_id = $1 FOR UPDATE",
      [invitedId]
    );
    const firstSeen = existingMember.rows.length === 0;

    if (firstSeen) {
      await client.query(
        `
          INSERT INTO channel_members (
            user_id, username, first_name, last_name, first_seen_at, joined_at,
            active, last_status, first_inviter_id, first_invite_link
          )
          VALUES ($1, $2, $3, $4, TO_TIMESTAMP($5), TO_TIMESTAMP($5), TRUE, $6, $7, $8)
        `,
        [
          invitedId,
          username(invited),
          invited.first_name || null,
          invited.last_name || null,
          memberUpdate.date,
          memberUpdate.new_chat_member.status,
          inviterId,
          memberUpdate.invite_link ? memberUpdate.invite_link.invite_link : null
        ]
      );
    } else {
      await client.query(
        `
          UPDATE channel_members
          SET
            username = $2,
            first_name = $3,
            last_name = $4,
            joined_at = TO_TIMESTAMP($5),
            left_at = NULL,
            active = TRUE,
            last_status = $6,
            updated_at = NOW()
          WHERE user_id = $1
        `,
        [
          invitedId,
          username(invited),
          invited.first_name || null,
          invited.last_name || null,
          memberUpdate.date,
          memberUpdate.new_chat_member.status
        ]
      );
    }

    const existingReferral = await client.query(
      "SELECT inviter_id, active FROM referrals WHERE invited_user_id = $1 FOR UPDATE",
      [invitedId]
    );

    if (existingReferral.rows.length > 0) {
      await client.query(
        `
          UPDATE referrals
          SET
            active = TRUE,
            left_at = NULL,
            invited_username = $2,
            invited_first_name = $3,
            invited_last_name = $4,
            last_status = $5,
            updated_at = NOW()
          WHERE invited_user_id = $1
        `,
        [
          invitedId,
          username(invited),
          invited.first_name || null,
          invited.last_name || null,
          memberUpdate.new_chat_member.status
        ]
      );

      if (!existingReferral.rows[0].active) {
        awardInviterId = String(existingReferral.rows[0].inviter_id);
      }
      return;
    }

    if (!firstSeen || !inviterId) return;

    await client.query(
      `
        INSERT INTO referrals (
          invited_user_id, inviter_id, invited_username, invited_first_name,
          invited_last_name, invite_link, joined_at, active, last_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, TO_TIMESTAMP($7), TRUE, $8)
      `,
      [
        invitedId,
        inviterId,
        username(invited),
        invited.first_name || null,
        invited.last_name || null,
        memberUpdate.invite_link.invite_link,
        memberUpdate.date,
        memberUpdate.new_chat_member.status
      ]
    );
    awardInviterId = inviterId;
  });

  if (awardInviterId) {
    await awardRewards(awardInviterId);
  }
}

async function recordLeave(memberUpdate) {
  const invited = memberUpdate.new_chat_member.user;
  const invitedId = userId(invited);

  await query(
    `
      UPDATE channel_members
      SET active = FALSE, left_at = TO_TIMESTAMP($2), last_status = $3, updated_at = NOW()
      WHERE user_id = $1 AND active = TRUE
    `,
    [invitedId, memberUpdate.date, memberUpdate.new_chat_member.status]
  );

  const result = await query(
    `
      UPDATE referrals
      SET active = FALSE, left_at = TO_TIMESTAMP($2), last_status = $3, updated_at = NOW()
      WHERE invited_user_id = $1 AND active = TRUE
      RETURNING inviter_id
    `,
    [invitedId, memberUpdate.date, memberUpdate.new_chat_member.status]
  );

  if (result.rows[0]) {
    await fulfillPendingRewardsForInviter(String(result.rows[0].inviter_id));
  }
}

async function handleChatMember(memberUpdate) {
  if (!isTargetChat(memberUpdate.chat)) return;

  const wasActive = isActiveMember(memberUpdate.old_chat_member);
  const isActive = isActiveMember(memberUpdate.new_chat_member);

  if (!wasActive && isActive) {
    const rawLink = memberUpdate.invite_link && memberUpdate.invite_link.invite_link;
    const inviter = rawLink ? await getInviterByLink(rawLink) : null;

    await recordMemberJoin(memberUpdate, inviter);
    return;
  }

  if (wasActive && !isActive) {
    await recordLeave(memberUpdate);
  }
}

async function reserveCdk(client, inviterId) {
  const cdk = await client.query(
    "SELECT id, code FROM cdks WHERE used_by IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED"
  );
  if (!cdk.rows[0]) return null;

  await client.query(
    "UPDATE cdks SET used_by = $1, used_at = NOW() WHERE id = $2",
    [inviterId, cdk.rows[0].id]
  );

  return cdk.rows[0];
}

async function deliverReward(rewardId, inviterId, cdkCode, rewardNumber) {
  try {
    await sendMessage(
      inviterId,
      [
        `你已达成第 ${rewardNumber} 次邀请奖励。`,
        `CDK：${cdkCode}`,
        "",
        "请妥善保存，每个 CDK 只能使用一次。"
      ].join("\n")
    );
    await query(
      "UPDATE rewards SET delivered_at = NOW(), delivery_error = NULL WHERE id = $1",
      [rewardId]
    );
  } catch (error) {
    await query(
      "UPDATE rewards SET delivery_error = $2 WHERE id = $1",
      [rewardId, error.message.slice(0, 500)]
    );
    await notifyAdmins(`CDK 发放失败：用户 ${inviterId}，奖励 ${rewardNumber}，错误：${error.message}`);
  }
}

async function deliverBonusReward(rewardId, inviterId, cdkCode, threshold) {
  try {
    await sendMessage(
      inviterId,
      [
        `你已达成邀请满 ${threshold} 人额外奖励。`,
        `额外 CDK：${cdkCode}`,
        "",
        "请妥善保存，每个 CDK 只能使用一次。"
      ].join("\n")
    );
    await query(
      "UPDATE bonus_rewards SET delivered_at = NOW(), delivery_error = NULL WHERE id = $1",
      [rewardId]
    );
  } catch (error) {
    await query(
      "UPDATE bonus_rewards SET delivery_error = $2 WHERE id = $1",
      [rewardId, error.message.slice(0, 500)]
    );
    await notifyAdmins(`额外 CDK 发放失败：用户 ${inviterId}，门槛 ${threshold} 人，错误：${error.message}`);
  }
}

async function createReward(inviterId, rewardNumber, activeCount) {
  const result = await transaction(async (client) => {
    const reward = await client.query(
      `
        INSERT INTO rewards (
          inviter_id, reward_number, active_count_at_award, cdk_id, delivery_error
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (inviter_id, reward_number) DO NOTHING
        RETURNING id
      `,
      [
        inviterId,
        rewardNumber,
        activeCount,
        null,
        "NO_CDK_STOCK"
      ]
    );
    if (!reward.rows[0]) return null;

    const cdk = await reserveCdk(client, inviterId);
    if (cdk) {
      await client.query(
        "UPDATE rewards SET cdk_id = $2, delivery_error = NULL WHERE id = $1",
        [reward.rows[0].id, cdk.id]
      );
    }

    return {
      rewardId: reward.rows[0].id,
      cdkCode: cdk ? cdk.code : null
    };
  });

  if (!result) return;

  if (result.cdkCode) {
    await deliverReward(result.rewardId, inviterId, result.cdkCode, rewardNumber);
  } else {
    await sendMessage(
      inviterId,
      "你已达成邀请奖励，但当前 CDK 库存不足。补货后会自动补发。"
    ).catch(() => null);
    await notifyAdmins(`CDK 库存不足：用户 ${inviterId} 已达成第 ${rewardNumber} 次奖励。`);
  }
}

async function createBonusReward(inviterId, bonusKey, threshold, activeCount) {
  const result = await transaction(async (client) => {
    const reward = await client.query(
      `
        INSERT INTO bonus_rewards (
          inviter_id, bonus_key, threshold, active_count_at_award, cdk_id, delivery_error
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (inviter_id, bonus_key) DO NOTHING
        RETURNING id
      `,
      [
        inviterId,
        bonusKey,
        threshold,
        activeCount,
        null,
        "NO_CDK_STOCK"
      ]
    );
    if (!reward.rows[0]) return null;

    const cdk = await reserveCdk(client, inviterId);
    if (cdk) {
      await client.query(
        "UPDATE bonus_rewards SET cdk_id = $2, delivery_error = NULL WHERE id = $1",
        [reward.rows[0].id, cdk.id]
      );
    }

    return {
      rewardId: reward.rows[0].id,
      cdkCode: cdk ? cdk.code : null
    };
  });

  if (!result) return;

  if (result.cdkCode) {
    await deliverBonusReward(result.rewardId, inviterId, result.cdkCode, threshold);
  } else {
    await sendMessage(
      inviterId,
      `你已达成邀请满 ${threshold} 人额外奖励，但当前 CDK 库存不足。补货后会自动补发。`
    ).catch(() => null);
    await notifyAdmins(`CDK 库存不足：用户 ${inviterId} 已达成邀请满 ${threshold} 人额外奖励。`);
  }
}

async function awardRewards(inviterId) {
  const blacklist = await getBlacklistEntry(inviterId);
  if (blacklist) {
    await markPendingRewardsBlacklisted(inviterId);
    await suppressBlacklistedRewards(inviterId);
    if (!blacklist.last_notified_at) {
      await notifyBlacklistedUser(inviterId, blacklist);
    }
    return;
  }

  const stats = await getStats(inviterId);
  const regularEligibleRewards = Math.floor(stats.activeCount / config.inviteTarget);
  const shouldHaveRewards = config.maxRewardsPerInviter === 0
    ? regularEligibleRewards
    : Math.min(regularEligibleRewards, config.maxRewardsPerInviter);

  for (let rewardNumber = stats.totalRewards + 1; rewardNumber <= shouldHaveRewards; rewardNumber += 1) {
    await createReward(inviterId, rewardNumber, stats.activeCount);
  }

  const bonusEligibleRewards = Math.floor(stats.activeCount / config.tenInviteBonusThreshold);
  for (let bonusNumber = stats.bonusTotalRewards + 1; bonusNumber <= bonusEligibleRewards; bonusNumber += 1) {
    const threshold = bonusNumber * config.tenInviteBonusThreshold;
    await createBonusReward(
      inviterId,
      bonusKeyForTier(bonusNumber),
      threshold,
      stats.activeCount
    );
  }

  await fulfillPendingRewardsForInviter(inviterId);
}

async function fulfillPendingRewardsForInviter(inviterId) {
  const blacklist = await getBlacklistEntry(inviterId);
  if (blacklist) {
    await markPendingRewardsBlacklisted(inviterId);
    await suppressBlacklistedRewards(inviterId);
    return;
  }

  const active = await query(
    "SELECT COUNT(*)::int AS count FROM referrals WHERE inviter_id = $1 AND active = TRUE",
    [inviterId]
  );
  const activeCount = active.rows[0].count;
  const pending = await query(
    `
      SELECT id, reward_number
      FROM rewards
      WHERE inviter_id = $1 AND cdk_id IS NULL
        AND COALESCE(delivery_error, '') <> 'BLACKLISTED'
      ORDER BY reward_number
    `,
    [inviterId]
  );

  for (const reward of pending.rows) {
    if (activeCount < reward.reward_number * config.inviteTarget) {
      await query(
        "UPDATE rewards SET delivery_error = $2 WHERE id = $1",
        [reward.id, "WAITING_ACTIVE_COUNT"]
      );
      continue;
    }

    const reserved = await transaction(async (client) => {
      const locked = await client.query(
        "SELECT id FROM rewards WHERE id = $1 AND cdk_id IS NULL AND COALESCE(delivery_error, '') <> 'BLACKLISTED' FOR UPDATE",
        [reward.id]
      );
      if (!locked.rows[0]) return null;

      const cdk = await reserveCdk(client, inviterId);
      if (!cdk) {
        await client.query(
          "UPDATE rewards SET delivery_error = $2 WHERE id = $1",
          [reward.id, "NO_CDK_STOCK"]
        );
        return null;
      }

      await client.query(
        "UPDATE rewards SET cdk_id = $2, delivery_error = NULL WHERE id = $1",
        [reward.id, cdk.id]
      );

      return { cdkCode: cdk.code };
    });

    if (reserved) {
      await deliverReward(reward.id, inviterId, reserved.cdkCode, reward.reward_number);
    }
  }

  const pendingBonuses = await query(
    `
      SELECT id, bonus_key, threshold
      FROM bonus_rewards
      WHERE inviter_id = $1 AND cdk_id IS NULL
        AND COALESCE(delivery_error, '') <> 'BLACKLISTED'
      ORDER BY threshold, id
    `,
    [inviterId]
  );

  for (const reward of pendingBonuses.rows) {
    if (activeCount < reward.threshold) {
      await query(
        "UPDATE bonus_rewards SET delivery_error = $2 WHERE id = $1",
        [reward.id, "WAITING_ACTIVE_COUNT"]
      );
      continue;
    }

    const reserved = await transaction(async (client) => {
      const locked = await client.query(
        "SELECT id FROM bonus_rewards WHERE id = $1 AND cdk_id IS NULL AND COALESCE(delivery_error, '') <> 'BLACKLISTED' FOR UPDATE",
        [reward.id]
      );
      if (!locked.rows[0]) return null;

      const cdk = await reserveCdk(client, inviterId);
      if (!cdk) {
        await client.query(
          "UPDATE bonus_rewards SET delivery_error = $2 WHERE id = $1",
          [reward.id, "NO_CDK_STOCK"]
        );
        return null;
      }

      await client.query(
        "UPDATE bonus_rewards SET cdk_id = $2, delivery_error = NULL WHERE id = $1",
        [reward.id, cdk.id]
      );

      return { cdkCode: cdk.code };
    });

    if (reserved) {
      await deliverBonusReward(reward.id, inviterId, reserved.cdkCode, reward.threshold);
    }
  }
}

async function fulfillAllPendingRewards() {
  await syncEligibleRewards();

  const inviters = await query(
    `
      SELECT DISTINCT inviter_id
      FROM rewards
      WHERE cdk_id IS NULL
      UNION
      SELECT DISTINCT inviter_id
      FROM bonus_rewards
      WHERE cdk_id IS NULL
      ORDER BY inviter_id
    `
  );

  for (const row of inviters.rows) {
    await fulfillPendingRewardsForInviter(String(row.inviter_id));
  }
}

async function syncEligibleRewards() {
  const inviters = await query(
    `
      SELECT inviter_id::text AS inviter_id
      FROM referrals
      WHERE active = TRUE
      GROUP BY inviter_id
      HAVING COUNT(*) >= $1
      ORDER BY inviter_id
    `,
    [Math.min(config.inviteTarget, config.tenInviteBonusThreshold)]
  );

  for (const row of inviters.rows) {
    await awardRewards(row.inviter_id);
  }

  return inviters.rows.length;
}

async function handleUpdate(update) {
  try {
    if (update.message) {
      await handleMessage(update.message);
      return;
    }

    if (update.chat_member) {
      await handleChatMember(update.chat_member);
    }
  } catch (error) {
    await notifyAdmins(`Bot 处理更新失败：${error.message}`);
    throw error;
  }
}

module.exports = {
  handleUpdate,
  handleMessage,
  handleChatMember,
  getOrCreateInviteLink,
  getStats,
  addCdks,
  awardRewards,
  fulfillAllPendingRewards,
  displayName
};
