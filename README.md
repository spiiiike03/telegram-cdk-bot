# Telegram CDK 邀请奖励 Bot

这个项目用于 Telegram 频道拉新奖励：

- 用户私聊 bot，通过 `/link` 获取专属频道邀请链接
- 新用户通过该专属链接加入频道后，bot 记录邀请关系
- 每 5 个有效邀请自动发放 1 个 CDK
- 每个邀请人最多发放 50 次
- 新人退频道后，有效邀请数扣回
- 同一个新人只会绑定第一次归因，反复进出不会重复刷奖励

## 重要限制

你的频道是公开频道，公开链接是 `https://t.me/spiiiike03`，也就是 `@spiiiike03`。

Telegram 只会在成员通过邀请链接加入时，把 `invite_link` 放进 `chat_member` 更新里。用户直接搜索频道或点击公开链接加入时，bot 无法知道是谁邀请的，因此不会计入奖励。

## 部署选择

推荐：Vercel + Neon Postgres。

不要在 Vercel 上用 SQLite 保存业务数据。Vercel 函数的本地文件系统不适合持久化数据库，邀请记录和 CDK 使用状态应该放到 Postgres。

## 先做安全处理

你之前把 bot token 发到了聊天里。请在 BotFather 里执行：

```text
/revoke
```

为 `@spiiiikebot` 重新生成 token。新 token 只放进 Vercel 环境变量，不要提交到 GitHub。

## 环境变量

在 Vercel 项目里配置：

```text
BOT_TOKEN=新的 BotFather token
BOT_USERNAME=spiiiikebot
CHANNEL_USERNAME=@spiiiike03
PUBLIC_CHANNEL_URL=https://t.me/spiiiike03
DATABASE_URL=Neon 的 pooled Postgres 连接串
WEBHOOK_SECRET=随机长字符串
SETUP_SECRET=另一个随机长字符串
ADMIN_IDS=你的 Telegram 数字 user id
INVITE_TARGET=5
MAX_REWARDS_PER_INVITER=50
```

不知道自己的 Telegram 数字 user id 时，部署后先私聊 bot 发送 `/id`。

## 数据库

在 Neon 创建 Postgres 项目，复制 pooled connection string，放到 `DATABASE_URL`。

最简单流程：

1. 打开 `https://neon.tech/`
2. 用 GitHub 登录
3. 点击 `New Project`
4. 项目名可以填 `telegram-cdk-bot`
5. 创建完成后，进入项目 Dashboard
6. 点击 `Connect`
7. 选择数据库 `neondb`
8. 打开 `Connection pooling`，复制带 `-pooler` 的连接串
9. 把这串填到 Vercel 环境变量 `DATABASE_URL`

连接串应该类似这样：

```text
postgresql://用户名:密码@xxx-pooler.xxx.aws.neon.tech/neondb?sslmode=require
```

看到主机名里有 `-pooler` 就对了。

部署后执行一次建表：

```powershell
curl.exe -X POST "https://你的-vercel域名/api/setup" -H "x-setup-secret: 你的SETUP_SECRET"
```

成功返回：

```json
{"ok":true,"migrated":true}
```

## 设置 Webhook

本地有 Node.js 时，在项目目录创建 `.env`，参考 `.env.example` 填好变量，然后执行：

```powershell
npm install
npm run set-webhook
```

也可以直接调用 Telegram API：

```text
https://api.telegram.org/bot<新TOKEN>/setWebhook?url=https://你的-vercel域名/api/webhook&allowed_updates=["message","chat_member"]&secret_token=<WEBHOOK_SECRET>
```

建议用脚本方式，避免 token 出现在浏览器历史里。

## 管理命令

用户命令：

```text
/start
/link
/status
/id
```

管理员命令：

```text
/addcdk CODE1 CODE2 CODE3
/inventory
```

也可以换行批量导入：

```text
/addcdk
AAA-111
BBB-222
CCC-333
```

本地批量导入文件：

```powershell
npm run import-cdks -- .\cdks.txt
```

`cdks.txt` 每行一个 CDK，空行和 `#` 开头的行会跳过。

## 健康检查

部署后访问：

```text
https://你的-vercel域名/api/health
```

如果数据库连接正常，会返回 `ok: true`。

## 频道权限

bot 必须是频道管理员，并且需要具备邀请用户权限。Telegram Bot API 对应字段是 `can_invite_users`。

如果 Telegram 客户端里显示的是“添加订阅者”，通常就是这个权限。部署后可以本地运行：

```powershell
npm run check
```

输出里应看到：

```text
can_invite_users: true
```

查看当前 webhook 状态：

```powershell
npm run webhook-info
```

## 推荐上线流程

1. 在 BotFather revoke 旧 token，生成新 token
2. 创建 Neon Postgres，拿 pooled `DATABASE_URL`
3. 把这个目录推到 GitHub
4. Vercel 导入 GitHub 仓库
5. 在 Vercel 配置环境变量并部署
6. 调用 `/api/setup` 建表
7. 运行 `npm run set-webhook`
8. 私聊 bot 发送 `/id`，把自己的数字 id 填进 `ADMIN_IDS` 后重新部署
9. 用 `/addcdk` 导入 CDK
10. 用 `/link` 获取邀请链接并测试加入/退出计数
