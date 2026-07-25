# Discord Linker Bot

A Discord bot for managing console account linking with a key-based balance system. Supports Xbox and PlayStation, SellAuth integration, and full admin controls.

---

## Quick Start

### 1. Prerequisites

- **Node.js 18+** (download at nodejs.org)
- **PostgreSQL** database (local or hosted — e.g. Neon, Supabase, Railway)
- A **Discord bot** created at discord.com/developers/applications

### 2. Create your Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** → click **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, enable **Server Members Intent** (recommended)
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Use Slash Commands`, `Embed Links`
6. Copy the generated URL and open it to invite the bot to your server

### 3. Install & configure

```bash
# Install dependencies
npm install

# Copy and fill in the env file
cp .env.example .env
# Edit .env with your DISCORD_BOT_TOKEN and DATABASE_URL
```

### 4. Set up the database

```bash
npm run migrate
```

This creates all required tables in your PostgreSQL database.

### 5. Run the bot

```bash
# Development (auto-restarts on changes)
npm run dev

# Production
npm run build
npm start
```

---

## Commands

### User Commands

| Command | Description |
|---|---|
| `/redeem [key]` | Redeem a key to add 1 link balance |
| `/link` | Link a console account (uses 1 balance) |
| `/balance` | Check your link balance |

### Admin Commands
*(Require Administrator or Manage Server permission)*

| Command | Description |
|---|---|
| `/genkey [count]` | Generate redeemable keys (up to 100 at once) |
| `/keys [filter]` | View server keys with active/redeemed/invalid counts |
| `/checkkey [key]` | Check a key's status and redemption info |
| `/removekey [key]` | Deactivate a key so it can't be redeemed |
| `/balance [user]` | Check another user's balance |
| `/removebalance [user] [amount?]` | Remove balance from a user (blank = remove all) |
| `/setchannel [channel]` | Restrict /link to a specific channel |
| `/settutorial [platform] [url]` | Set the Xbox or PSN tutorial video link |
| `/sellsetup [api_key] [product_id]` | Connect your SellAuth store |
| `/injectkeys` | Push all active keys into your SellAuth product |
| `/uninjectkeys` | Remove all keys from your SellAuth product |

---

## How the linking flow works

1. Admin runs `/genkey 10` → generates 10 key codes
2. Customer receives a key (e.g. from SellAuth order)
3. Customer runs `/redeem XXXX-XXXX-XXXX-XXXX` → gets 1 link balance
4. Customer runs `/link` → selects Xbox or PlayStation → enters their gamertag/PSN ID
5. Bot deducts 1 balance, records the link, and sends the tutorial video

---

## SellAuth Integration

1. Run `/sellsetup [your_api_key] [product_id]` in your server
2. Run `/genkey [count]` to generate keys
3. Run `/injectkeys` to push all active keys into your SellAuth product
4. As customers purchase, SellAuth delivers keys automatically
5. Use `/uninjectkeys` to remove unsold keys if needed

---

## Production Hosting

Recommended free/cheap options:

- **Railway** — railway.app (includes PostgreSQL)
- **Render** — render.com (free tier available)
- **Fly.io** — fly.io

Set `DISCORD_BOT_TOKEN` and `DATABASE_URL` as environment variables on your host, then run `npm run migrate` once and `npm start`.
