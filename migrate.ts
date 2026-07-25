/**
 * Run this once to create all database tables:
 *   npx tsx src/migrate.ts
 */
import pg from "pg";
import "dotenv/config";

const { Client } = pg;

const DROP_STATEMENTS = [
  `DROP TABLE IF EXISTS bot_console_links CASCADE;`,
  `DROP TABLE IF EXISTS bot_user_balances CASCADE;`,
  `DROP TABLE IF EXISTS bot_keys CASCADE;`,
  `DROP TABLE IF EXISTS bot_guild_config CASCADE;`,
  `DROP TYPE IF EXISTS key_status CASCADE;`,
  `DROP TYPE IF EXISTS console_platform CASCADE;`,
];

const DROPPED_TABLES = [
  "bot_console_links",
  "bot_user_balances",
  "bot_keys",
  "bot_guild_config",
];

const CREATE_STATEMENTS = [
  `CREATE TYPE key_status AS ENUM ('active', 'redeemed', 'invalid');`,
  `CREATE TYPE console_platform AS ENUM ('xbox', 'playstation');`,
  `CREATE TABLE bot_keys (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  status      key_status NOT NULL DEFAULT 'active',
  created_by  TEXT NOT NULL,
  redeemed_by TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  redeemed_at TIMESTAMP
);`,
  `CREATE TABLE bot_user_balances (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);`,
  `CREATE TABLE bot_guild_config (
  guild_id           TEXT PRIMARY KEY,
  link_channel_id    TEXT,
  sellauth_api_key   TEXT,
  sellauth_product_id TEXT,
  xbox_tutorial_url  TEXT,
  psn_tutorial_url   TEXT,
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);`,
  `CREATE TABLE bot_console_links (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  platform         console_platform NOT NULL,
  console_username TEXT NOT NULL,
  linked_at        TIMESTAMP NOT NULL DEFAULT NOW()
);`,
];

async function runStatement(client: pg.Client, statement: string): Promise<boolean> {
  console.log(`\n▶ Executing statement:\n${statement}`);
  try {
    await client.query(statement);
    console.log("✅ Statement succeeded.");
    return true;
  } catch (err) {
    console.error("❌ Statement failed:", err);
    return false;
  }
}

async function verifyTablesDropped(client: pg.Client) {
  console.log("\n🔍 Verifying dropped tables no longer exist...");
  for (const table of DROPPED_TABLES) {
    try {
      const result = await client.query(
        `SELECT to_regclass($1) AS exists;`,
        [`public.${table}`]
      );
      const exists = result.rows[0]?.exists !== null;
      if (exists) {
        console.error(`❌ Table "${table}" still exists after DROP TABLE!`);
      } else {
        console.log(`✅ Table "${table}" confirmed dropped.`);
      }
    } catch (err) {
      console.error(`❌ Failed to verify drop for table "${table}":`, err);
    }
  }
}

async function logExistingTables(client: pg.Client) {
  console.log("\n📋 Tables currently in the public schema:");
  try {
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;`
    );
    for (const row of result.rows) {
      console.log(`  - ${row.table_name}`);
    }
  } catch (err) {
    console.error("❌ Failed to list tables:", err);
  }
}

async function logBotKeysColumns(client: pg.Client) {
  console.log("\n📋 Columns on bot_keys (if it exists):");
  try {
    const result = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bot_keys' ORDER BY ordinal_position;`
    );
    if (result.rows.length === 0) {
      console.log("  (table not found or has no columns)");
    }
    for (const row of result.rows) {
      console.log(`  - ${row.column_name} (${row.data_type})`);
    }
  } catch (err) {
    console.error("❌ Failed to list columns for bot_keys:", err);
  }
}

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("Running migrations...");

  console.log("\n=== Step 1: Dropping existing tables/types ===");
  for (const statement of DROP_STATEMENTS) {
    await runStatement(client, statement);
  }

  await verifyTablesDropped(client);

  console.log("\n=== Step 2: Creating new tables/types ===");
  for (const statement of CREATE_STATEMENTS) {
    await runStatement(client, statement);
  }

  await logExistingTables(client);
  await logBotKeysColumns(client);

  console.log("\n✅ Migration finished (see log above for any failed statements).");
  await client.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
