const { config, normalizeUsername } = require("./config");
const { query, transaction } = require("./db");
const { createInviteLink, notifyAdmins, sendMessage } = require("./telegram");

const ACTIVE_STATUSES = new Set(["creator", "administrator", "member"]);

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

async function getStats(inviterId) {
  const active = await query(
    "SELECT COUNT(*)::int AS count FROM referrals WHERE inviter_id = $1 AND active = TRUE",
    [inviterId]
  );
  const rewards = await query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(cdk_id)::int AS delivered,
        COUNT(*) FILTER (WHERE cdk_id IS NULL)::int AS pending
      FROM rewards
      WHERE inviter_id = $1
    `,
    [inviterId]
  );

  const activeCount = active.rows[0].count;
  const totalRewards = rewards.rows[0].total;
  const deliveredRewards = rewards.rows[0].delivered;
  const pendingRewards = rewards.rows[0].pending;
  const eligibleRewards = Math.min(
    Math.floor(activeCount / config.inviteTarget),
    config.maxRewardsPerInviter
  );
  const nextAt = Math.min((totalRewards + 1) * config.inviteTarget, config.maxRewardsPerInviter * config.inviteTarget);
  const needed = totalRewards >= config.maxRewardsPerInviter
    ? 0
    : Math.max(0, nextAt - activeCount);

  return {
    activeCount,
    totalRewards,
    deliveredRewards,
    pendingRewards,
    eligibleRewards,
    needed
  };
}

function statsText(link, stats) {
  return [
    "你的专属邀请链接：",
    link,
    "",
    `有效邀请：${stats.activeCount}`,
    `已发放 CDK：${stats.deliveredRewards}/${config.maxRewardsPerInviter}`,
    stats.pendingRewards > 0 ? `待补发 CDK：${stats.pendingRewards}` : null,
    stats.totalRewards >= config.maxRewardsPerInviter
      ? "你已达到最高奖励次数。"
      : `距离下一个 CDK 还差：${stats.needed} 人`,
    "",
    "只有通过上面的专属链接加入频道的新用户才会计入。"
  ].filter(Boolean).join("\n");
}

async function sendUserStats(user, chatId) {
  const link = await getOrCreateInviteLink(user);
  const stats = await getStats(userId(user));
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
        (SELECT COUNT(*)::int FROM rewards WHERE cdk_id IS NULL) AS pending
      FROM cdks
    `
  );
  const row = result.rows[0];
  await sendMessage(chatId, `CDK 库存：${row.unused}\n已使用：${row.used}\n待补发：${row.pending}`);
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

async function createReward(inviterId, rewardNumber, activeCount) {
  const result = await transaction(async (client) => {
    const existing = await client.query(
      "SELECT id, cdk_id FROM rewards WHERE inviter_id = $1 AND reward_number = $2 FOR UPDATE",
      [inviterId, rewardNumber]
    );
    if (existing.rows[0]) return null;

    const cdk = await reserveCdk(client, inviterId);
    const reward = await client.query(
      `
        INSERT INTO rewards (
          inviter_id, reward_number, active_count_at_award, cdk_id, delivery_error
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [
        inviterId,
        rewardNumber,
        activeCount,
        cdk ? cdk.id : null,
        cdk ? null : "NO_CDK_STOCK"
      ]
    );

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

async function awardRewards(inviterId) {
  const stats = await getStats(inviterId);
  const shouldHaveRewards = Math.min(
    Math.floor(stats.activeCount / config.inviteTarget),
    config.maxRewardsPerInviter
  );

  for (let rewardNumber = stats.totalRewards + 1; rewardNumber <= shouldHaveRewards; rewardNumber += 1) {
    await createReward(inviterId, rewardNumber, stats.activeCount);
  }

  await fulfillPendingRewardsForInviter(inviterId);
}

async function fulfillPendingRewardsForInviter(inviterId) {
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
        "SELECT id FROM rewards WHERE id = $1 AND cdk_id IS NULL FOR UPDATE",
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
}

async function fulfillAllPendingRewards() {
  const inviters = await query(
    "SELECT DISTINCT inviter_id FROM rewards WHERE cdk_id IS NULL ORDER BY inviter_id"
  );

  for (const row of inviters.rows) {
    await fulfillPendingRewardsForInviter(String(row.inviter_id));
  }
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
