CREATE TABLE IF NOT EXISTS inviters (
  user_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  invite_link TEXT UNIQUE,
  invite_link_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  invited_user_id BIGINT PRIMARY KEY,
  inviter_id BIGINT NOT NULL REFERENCES inviters(user_id),
  invited_username TEXT,
  invited_first_name TEXT,
  invited_last_name TEXT,
  invite_link TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS referrals_inviter_active_idx
  ON referrals(inviter_id, active);

CREATE INDEX IF NOT EXISTS referrals_inviter_idx
  ON referrals(inviter_id);

CREATE TABLE IF NOT EXISTS channel_members (
  user_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  last_status TEXT,
  first_inviter_id BIGINT REFERENCES inviters(user_id),
  first_invite_link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS channel_members_active_idx
  ON channel_members(active);

CREATE TABLE IF NOT EXISTS cdks (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  batch TEXT,
  used_by BIGINT REFERENCES inviters(user_id),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cdks_unused_idx
  ON cdks(id)
  WHERE used_by IS NULL;

CREATE TABLE IF NOT EXISTS rewards (
  id BIGSERIAL PRIMARY KEY,
  inviter_id BIGINT NOT NULL REFERENCES inviters(user_id),
  reward_number INTEGER NOT NULL,
  active_count_at_award INTEGER NOT NULL,
  cdk_id BIGINT UNIQUE REFERENCES cdks(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  delivery_error TEXT,
  UNIQUE(inviter_id, reward_number)
);

CREATE INDEX IF NOT EXISTS rewards_pending_idx
  ON rewards(id)
  WHERE cdk_id IS NULL;
