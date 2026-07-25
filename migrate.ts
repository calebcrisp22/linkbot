/**
 * Run this once to create all database tables:
 *   npx tsx src/migrate.ts
 */
import pg from "pg";
import "dotenv/config";

const { Client } = pg;

const STATEMENTS = [
  `DROP TYPE IF EXISTS key_status CASCADE;`,
  `CREATE TYPE key_status AS ENUM ('active', 'redeemed', 'invalid');`,
  `DROP TYPE IF EXISTS console_platform CASCADE;`,
  `CREATE TYPE console_platform AS ENUM ('xbox', 'playstation');`,
  `CREATE TABLE IF NOT EXISTS bot_keys (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  status      key_status NOT NULL DEFAULT 'active',
  created_by  TEXT NOT NULL,
  redeemed_by TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  redeemed_at TIMESTAMP
);`,
  `CREATE TABLE IF NOT EXISTS bot_user_balances (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);`,
  `CREATE TABLE IF NOT EXISTS bot_guild_config (
  guild_id           TEXT PRIMARY KEY,
  link_channel_id    TEXT,
  sellauth_api_key   TEXT,
  sellauth_product_id TEXT,
  xbox_tutorial_url  TEXT,
  psn_tutorial_url   TEXT,
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);`,
  `CREATE TABLE IF NOT EXISTS bot_console_links (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  platform         console_platform NOT NULL,
  console_username TEXT NOT NULL,
  linked_at        TIMESTAMP NOT NULL DEFAULT NOW()
);`,
];

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("Running migrations...");
  for (const statement of STATEMENTS) {
    await client.query(statement);
  }
  console.log("✅ Database tables created successfully.");
  await client.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
