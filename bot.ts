import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  type Interaction,
} from "discord.js";
import { eq, and } from "drizzle-orm";
import { db } from "./db.js";
import {
  keysTable,
  userBalancesTable,
  guildConfigTable,
  consoleLinksTable,
} from "./schema.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

// Temporary in-memory storage for link flow state between the first modal
// (console username) and second modal (Ubisoft credentials) submissions.
const pendingLinks = new Map<
  string,
  { platform: "xbox" | "playstation"; consoleUsername: string }
>();

function pendingLinkKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function generateKeyCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg = () =>
    Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

async function getBalance(guildId: string, userId: string): Promise<number> {
  const [row] = await db
    .select()
    .from(userBalancesTable)
    .where(
      and(
        eq(userBalancesTable.guildId, guildId),
        eq(userBalancesTable.userId, userId),
      ),
    );
  return row?.balance ?? 0;
}

async function modifyBalance(
  guildId: string,
  userId: string,
  delta: number,
): Promise<number> {
  const existing = await getBalance(guildId, userId);
  const newBalance = Math.max(0, existing + delta);
  await db
    .insert(userBalancesTable)
    .values({ guildId, userId, balance: newBalance, updatedAt: new Date() })
    .onConflictDoNothing();
  await db
    .update(userBalancesTable)
    .set({ balance: newBalance, updatedAt: new Date() })
    .where(
      and(
        eq(userBalancesTable.guildId, guildId),
        eq(userBalancesTable.userId, userId),
      ),
    );
  return newBalance;
}

async function getGuildConfig(guildId: string) {
  const [row] = await db
    .select()
    .from(guildConfigTable)
    .where(eq(guildConfigTable.guildId, guildId));
  return row ?? null;
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.memberPermissions) return false;
  return (
    interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function errorEmbed(msg: string) {
  return new EmbedBuilder().setColor(0xe74c3c).setDescription(`❌ ${msg}`);
}

function successEmbed(msg: string) {
  return new EmbedBuilder().setColor(0x2ecc71).setDescription(`✅ ${msg}`);
}

function infoEmbed(title: string, desc: string) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(desc);
}

type UbisoftLinkResult =
  | { ok: true }
  | { ok: false; reason: string };

async function linkUbisoftAccount(params: {
  platform: "xbox" | "playstation";
  consoleUsername: string;
  ubisoftEmail: string;
  ubisoftPassword: string;
}): Promise<UbisoftLinkResult> {
  try {
    const response = await fetch("https://api.ubisoft.com/v3/profiles/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform: params.platform,
        console_username: params.consoleUsername,
        ubisoft_email: params.ubisoftEmail,
        ubisoft_password: params.ubisoftPassword,
      }),
    });

    if (!response.ok) {
      let reason = `Ubisoft API returned status ${response.status}.`;
      try {
        const body = await response.json();
        if (body?.message) reason = body.message;
      } catch (_) {
        // ignore body parse errors
      }
      return { ok: false, reason };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? err.message
          : "Unknown error while contacting Ubisoft.",
    };
  }
}

// ─── Command Definitions ─────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link a console account")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("Redeem a key for link balance")
    .addStringOption((o) =>
      o
        .setName("key")
        .setDescription("Your redemption key")
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("genkey")
    .setDescription("Generate redeemable key(s) [Admin]")
    .addIntegerOption((o) =>
      o
        .setName("count")
        .setDescription("Number of keys to generate")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("injectkeys")
    .setDescription("Inject Linker keys into your SellAuth product store [Admin]")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your link balance")
    .addUserOption((o) =>
      o
        .setName("user")
        .setDescription("User to check (admin only)")
        .setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("keys")
    .setDescription("View this server's active & redeemed keys [Admin]")
    .addStringOption((o) =>
      o
        .setName("filter")
        .setDescription("Filter keys by status")
        .addChoices(
          { name: "All", value: "all" },
          { name: "Active", value: "active" },
          { name: "Redeemed", value: "redeemed" },
          { name: "Invalid", value: "invalid" },
        )
        .setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("uninjectkeys")
    .setDescription(
      "Remove Linker keys from products (keeps the account) [Admin]",
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("sellsetup")
    .setDescription("Connect a SellAuth store to this server [Admin]")
    .addStringOption((o) =>
      o
        .setName("api_key")
        .setDescription("Your SellAuth API key")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("product_id")
        .setDescription("Your SellAuth product ID")
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Set the channel where /link can be used [Admin]")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("The channel to restrict /link to")
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("removekey")
    .setDescription("Remove / deactivate a key so it can't be redeemed [Admin]")
    .addStringOption((o) =>
      o
        .setName("key")
        .setDescription("The key code to deactivate")
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("checkkey")
    .setDescription(
      "Check a key's status (active / redeemed / invalid) [Admin]",
    )
    .addStringOption((o) =>
      o
        .setName("key")
        .setDescription("The key code to check")
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("removebalance")
    .setDescription("Remove link balance from a user [Admin]")
    .addUserOption((o) =>
      o
        .setName("user")
        .setDescription("The user to remove balance from")
        .setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("amount")
        .setDescription(
          "Amount to remove (leave blank to remove ALL balance)",
        )
        .setRequired(false)
        .setMinValue(1),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("settutorial")
    .setDescription("Set the Xbox or PSN tutorial video link [Admin]")
    .addStringOption((o) =>
      o
        .setName("platform")
        .setDescription("Which platform tutorial to set")
        .addChoices(
          { name: "Xbox", value: "xbox" },
          { name: "PlayStation", value: "playstation" },
        )
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("url").setDescription("Tutorial video URL").setRequired(true),
    )
    .toJSON(),
];

// ─── Command Handlers ────────────────────────────────────────────────────────

async function handleLink(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("This command can only be used in a server.")],
      flags: 64,
    });
    return;
  }

  const config = await getGuildConfig(interaction.guildId);

  if (config?.linkChannelId && interaction.channelId !== config.linkChannelId) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          `You can only use **/link** in <#${config.linkChannelId}>.`,
        ),
      ],
      flags: 64,
    });
    return;
  }

  const balance = await getBalance(interaction.guildId, interaction.user.id);
  if (balance < 1) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle("❌ Insufficient Balance")
          .setDescription(
            "You need at least **1 link balance** to link a console account.\n\nUse `/redeem` with your key to add balance.",
          ),
      ],
      flags: 64,
    });
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("link_platform_select")
      .setPlaceholder("Choose your console platform")
      .addOptions(
        {
          label: "Xbox",
          description: "Link your Xbox / Gamertag",
          value: "xbox",
          emoji: "🎮",
        },
        {
          label: "PlayStation",
          description: "Link your PSN account",
          value: "playstation",
          emoji: "🎮",
        },
      ),
  );

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🔗 Console Linking")
        .setDescription(
          "Select your console platform to begin linking.\n\nThis will use **1 link balance**.",
        ),
    ],
    components: [row],
    flags: 64,
  });
}

async function handleRedeem(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("This command can only be used in a server.")],
      flags: 64,
    });
    return;
  }

  const keyCode = interaction.options
    .getString("key", true)
    .toUpperCase()
    .trim();

  const [key] = await db
    .select()
    .from(keysTable)
    .where(
      and(
        eq(keysTable.code, keyCode),
        eq(keysTable.guildId, interaction.guildId),
      ),
    );

  if (!key) {
    await interaction.reply({
      embeds: [
        errorEmbed("That key was not found. Check the code and try again."),
      ],
      flags: 64,
    });
    return;
  }

  if (key.status === "redeemed") {
    await interaction.reply({
      embeds: [errorEmbed("That key has already been redeemed.")],
      flags: 64,
    });
    return;
  }

  if (key.status === "invalid") {
    await interaction.reply({
      embeds: [
        errorEmbed(
          "That key has been invalidated and cannot be redeemed.",
        ),
      ],
      flags: 64,
    });
    return;
  }

  await db
    .update(keysTable)
    .set({
      status: "redeemed",
      redeemedBy: interaction.user.id,
      redeemedAt: new Date(),
    })
    .where(eq(keysTable.id, key.id));

  const newBalance = await modifyBalance(
    interaction.guildId,
    interaction.user.id,
    1,
  );

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("✅ Key Redeemed!")
        .setDescription(`Key \`${keyCode}\` redeemed successfully.`)
        .addFields({
          name: "New Balance",
          value: `**${newBalance}** link(s)`,
          inline: true,
        }),
    ],
    flags: 64,
  });
}

async function handleGenkey(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          "You need Administrator or Manage Server permissions.",
        ),
      ],
      flags: 64,
    });
    return;
  }

  const count = interaction.options.getInteger("count", true);
  await interaction.deferReply({ flags: 64 });

  const generated: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = generateKeyCode();
    await db.insert(keysTable).values({
      guildId: interaction.guildId,
      code,
      status: "active",
      createdBy: interaction.user.id,
    });
    generated.push(code);
  }

  const keyList = generated.map((k) => `\`${k}\``).join("\n");
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🔑 Generated ${count} Key${count > 1 ? "s" : ""}`)
    .setDescription(
      keyList.length <= 4000 ? keyList : keyList.slice(0, 3990) + "\n...",
    )
    .setFooter({ text: "Share these keys with your customers" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleBalance(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }

  const targetUser = interaction.options.getUser("user");

  if (targetUser && !isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Only admins can check other users' balance.")],
      flags: 64,
    });
    return;
  }

  const user = targetUser ?? interaction.user;
  const balance = await getBalance(interaction.guildId, user.id);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("💰 Link Balance")
        .setDescription(
          `**${user.username}** has **${balance}** link balance${balance !== 1 ? "s" : ""}.`,
        ),
    ],
    flags: 64,
  });
}

async function handleKeys(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const filter = (interaction.options.getString("filter") ?? "all") as
    | "all"
    | "active"
    | "redeemed"
    | "invalid";

  const allKeys = await db
    .select()
    .from(keysTable)
    .where(eq(keysTable.guildId, interaction.guildId));

  const filtered =
    filter === "all" ? allKeys : allKeys.filter((k) => k.status === filter);

  const counts = {
    active: allKeys.filter((k) => k.status === "active").length,
    redeemed: allKeys.filter((k) => k.status === "redeemed").length,
    invalid: allKeys.filter((k) => k.status === "invalid").length,
  };

  if (filtered.length === 0) {
    await interaction.editReply({
      embeds: [
        infoEmbed(
          "🔑 Keys",
          `No ${filter === "all" ? "" : filter + " "}keys found.`,
        ),
      ],
    });
    return;
  }

  const preview = filtered
    .slice(0, 20)
    .map((k) => {
      const icon =
        k.status === "active"
          ? "🟢"
          : k.status === "redeemed"
            ? "🔴"
            : "⚫";
      return `${icon} \`${k.code}\` — **${k.status}**`;
    })
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🔑 Server Keys")
    .addFields(
      { name: "🟢 Active", value: String(counts.active), inline: true },
      { name: "🔴 Redeemed", value: String(counts.redeemed), inline: true },
      { name: "⚫ Invalid", value: String(counts.invalid), inline: true },
      {
        name: `Showing ${Math.min(20, filtered.length)} of ${filtered.length}`,
        value: preview,
      },
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleInjectkeys(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const config = await getGuildConfig(interaction.guildId);
  if (!config?.sellAuthApiKey || !config?.sellAuthProductId) {
    await interaction.editReply({
      embeds: [
        errorEmbed("SellAuth is not configured. Use `/sellsetup` first."),
      ],
    });
    return;
  }

  const activeKeys = await db
    .select()
    .from(keysTable)
    .where(
      and(
        eq(keysTable.guildId, interaction.guildId),
        eq(keysTable.status, "active"),
      ),
    );

  if (activeKeys.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "No active keys to inject. Use `/genkey` to create some.",
        ),
      ],
    });
    return;
  }

  try {
    const keyCodes = activeKeys.map((k) => k.code);
    const resp = await fetch(
      `https://sellauth.com/api/v2/shops/me/products/${config.sellAuthProductId}/serials`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.sellAuthApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ serials: keyCodes }),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`SellAuth API error ${resp.status}: ${text}`);
    }

    await interaction.editReply({
      embeds: [
        successEmbed(
          `Successfully injected **${keyCodes.length}** key(s) into your SellAuth product.`,
        ),
      ],
    });
  } catch (err: any) {
    console.error("SellAuth inject failed:", err);
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `SellAuth injection failed: ${err?.message ?? "Unknown error"}`,
        ),
      ],
    });
  }
}

async function handleUninjectkeys(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const config = await getGuildConfig(interaction.guildId);
  if (!config?.sellAuthApiKey || !config?.sellAuthProductId) {
    await interaction.editReply({
      embeds: [
        errorEmbed("SellAuth is not configured. Use `/sellsetup` first."),
      ],
    });
    return;
  }

  try {
    const resp = await fetch(
      `https://sellauth.com/api/v2/shops/me/products/${config.sellAuthProductId}/serials`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${config.sellAuthApiKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`SellAuth API error ${resp.status}: ${text}`);
    }

    await interaction.editReply({
      embeds: [
        successEmbed(
          "Successfully removed all Linker keys from your SellAuth product.",
        ),
      ],
    });
  } catch (err: any) {
    console.error("SellAuth uninject failed:", err);
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `SellAuth removal failed: ${err?.message ?? "Unknown error"}`,
        ),
      ],
    });
  }
}

async function handleSellsetup(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  const apiKey = interaction.options.getString("api_key", true);
  const productId = interaction.options.getString("product_id", true);

  await db
    .insert(guildConfigTable)
    .values({
      guildId: interaction.guildId,
      sellAuthApiKey: apiKey,
      sellAuthProductId: productId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: guildConfigTable.guildId,
      set: {
        sellAuthApiKey: apiKey,
        sellAuthProductId: productId,
        updatedAt: new Date(),
      },
    });

  await interaction.reply({
    embeds: [
      successEmbed(
        `SellAuth store connected successfully.\nProduct ID: \`${productId}\``,
      ),
    ],
    flags: 64,
  });
}

async function handleSetchannel(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);

  await db
    .insert(guildConfigTable)
    .values({
      guildId: interaction.guildId,
      linkChannelId: channel.id,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: guildConfigTable.guildId,
      set: { linkChannelId: channel.id, updatedAt: new Date() },
    });

  await interaction.reply({
    embeds: [
      successEmbed(
        `The **/link** command is now restricted to <#${channel.id}>.`,
      ),
    ],
  });
}

async function handleRemovekey(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  const keyCode = interaction.options
    .getString("key", true)
    .toUpperCase()
    .trim();

  const [key] = await db
    .select()
    .from(keysTable)
    .where(
      and(
        eq(keysTable.code, keyCode),
        eq(keysTable.guildId, interaction.guildId),
      ),
    );

  if (!key) {
    await interaction.reply({
      embeds: [errorEmbed("Key not found.")],
      flags: 64,
    });
    return;
  }

  await db
    .update(keysTable)
    .set({ status: "invalid" })
    .where(eq(keysTable.id, key.id));

  await interaction.reply({
    embeds: [
      successEmbed(
        `Key \`${keyCode}\` has been deactivated and can no longer be redeemed.`,
      ),
    ],
    flags: 64,
  });
}

async function handleCheckkey(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  const keyCode = interaction.options
    .getString("key", true)
    .toUpperCase()
    .trim();

  const [key] = await db
    .select()
    .from(keysTable)
    .where(
      and(
        eq(keysTable.code, keyCode),
        eq(keysTable.guildId, interaction.guildId),
      ),
    );

  if (!key) {
    await interaction.reply({
      embeds: [errorEmbed("Key not found.")],
      flags: 64,
    });
    return;
  }

  const statusIcon =
    key.status === "active" ? "🟢" : key.status === "redeemed" ? "🔴" : "⚫";
  const embed = new EmbedBuilder()
    .setColor(
      key.status === "active"
        ? 0x2ecc71
        : key.status === "redeemed"
          ? 0xe74c3c
          : 0x95a5a6,
    )
    .setTitle(`${statusIcon} Key Status`)
    .addFields(
      { name: "Code", value: `\`${key.code}\``, inline: true },
      { name: "Status", value: `**${key.status.toUpperCase()}**`, inline: true },
      {
        name: "Created",
        value: `<t:${Math.floor(key.createdAt.getTime() / 1000)}:R>`,
        inline: true,
      },
    );

  if (key.redeemedBy) {
    embed.addFields(
      { name: "Redeemed By", value: `<@${key.redeemedBy}>`, inline: true },
      {
        name: "Redeemed At",
        value: key.redeemedAt
          ? `<t:${Math.floor(key.redeemedAt.getTime() / 1000)}:R>`
          : "Unknown",
        inline: true,
      },
    );
  }

  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleRemovebalance(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount");

  if (amount !== null) {
    const before = await getBalance(interaction.guildId, targetUser.id);
    const removed = Math.min(amount, before);
    await modifyBalance(interaction.guildId, targetUser.id, -removed);
    const after = await getBalance(interaction.guildId, targetUser.id);
    await interaction.reply({
      embeds: [
        successEmbed(
          `Removed **${removed}** balance from ${targetUser.username}. New balance: **${after}**.`,
        ),
      ],
      flags: 64,
    });
  } else {
    await db
      .update(userBalancesTable)
      .set({ balance: 0, updatedAt: new Date() })
      .where(
        and(
          eq(userBalancesTable.guildId, interaction.guildId),
          eq(userBalancesTable.userId, targetUser.id),
        ),
      );
    await interaction.reply({
      embeds: [
        successEmbed(
          `Removed **all** link balance from ${targetUser.username}.`,
        ),
      ],
      flags: 64,
    });
  }
}

async function handleSettutorial(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed("Admin only.")],
      flags: 64,
    });
    return;
  }

  const platform = interaction.options.getString(
    "platform",
    true,
  ) as "xbox" | "playstation";
  const url = interaction.options.getString("url", true);

  const updateData =
    platform === "xbox"
      ? { xboxTutorialUrl: url, updatedAt: new Date() }
      : { psnTutorialUrl: url, updatedAt: new Date() };

  await db
    .insert(guildConfigTable)
    .values({ guildId: interaction.guildId, ...updateData })
    .onConflictDoUpdate({
      target: guildConfigTable.guildId,
      set: updateData,
    });

  const platformName = platform === "xbox" ? "Xbox" : "PlayStation";
  await interaction.reply({
    embeds: [successEmbed(`${platformName} tutorial URL has been set.`)],
    flags: 64,
  });
}

// ─── Select Menu & Modal Handlers ────────────────────────────────────────────

async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  if (interaction.customId === "link_platform_select") {
    const platform = interaction.values[0] as "xbox" | "playstation";
    const platformName =
      platform === "xbox" ? "Xbox / Gamertag" : "PlayStation Network";

    const modal = new ModalBuilder()
      .setCustomId(`link_modal_${platform}`)
      .setTitle(`Link ${platformName}`);

    const usernameInput = new TextInputBuilder()
      .setCustomId("console_username")
      .setLabel(platform === "xbox" ? "Your Xbox Gamertag" : "Your PSN ID")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(
        platform === "xbox" ? "e.g. CoolGamer123" : "e.g. CoolGamer_PSN",
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(64);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(usernameInput),
    );

    await interaction.showModal(modal);
  }
}

async function handleModalSubmit(interaction: ModalSubmitInteraction) {
  if (interaction.customId.startsWith("link_modal_")) {
    await handleConsoleUsernameModal(interaction);
  } else if (interaction.customId.startsWith("link_credentials_")) {
    await handleUbisoftCredentialsModal(interaction);
  }
}

async function handleConsoleUsernameModal(interaction: ModalSubmitInteraction) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }

  const platform = interaction.customId.replace(
    "link_modal_",
    "",
  ) as "xbox" | "playstation";
  const consoleUsername = interaction.fields
    .getTextInputValue("console_username")
    .trim();

  const balance = await getBalance(interaction.guildId, interaction.user.id);
  if (balance < 1) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          "You no longer have enough link balance. Use `/redeem` to add balance.",
        ),
      ],
      flags: 64,
    });
    return;
  }

  // Stash the console username so it can be combined with the Ubisoft
  // credentials collected in the second modal.
  pendingLinks.set(pendingLinkKey(interaction.guildId, interaction.user.id), {
    platform,
    consoleUsername,
  });

  const modal = new ModalBuilder()
    .setCustomId(`link_credentials_${platform}`)
    .setTitle("Ubisoft Account Credentials");

  const emailInput = new TextInputBuilder()
    .setCustomId("ubisoft_email")
    .setLabel("Ubisoft Account Email")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("you@example.com")
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(128);

  const passwordInput = new TextInputBuilder()
    .setCustomId("ubisoft_password")
    .setLabel("Ubisoft Account Password")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Your Ubisoft password")
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(128);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(emailInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(passwordInput),
  );

  await interaction.showModal(modal);
}

async function handleUbisoftCredentialsModal(
  interaction: ModalSubmitInteraction,
) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed("Server only.")],
      flags: 64,
    });
    return;
  }

  const platform = interaction.customId.replace(
    "link_credentials_",
    "",
  ) as "xbox" | "playstation";

  const pending = pendingLinks.get(
    pendingLinkKey(interaction.guildId, interaction.user.id),
  );

  await interaction.deferReply({ flags: 64 });

  if (!pending || pending.platform !== platform) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Your linking session expired or is invalid. Please run `/link` again.",
        ),
      ],
    });
    return;
  }

  const ubisoftEmail = interaction.fields
    .getTextInputValue("ubisoft_email")
    .trim();
  const ubisoftPassword = interaction.fields.getTextInputValue(
    "ubisoft_password",
  );

  const balance = await getBalance(interaction.guildId, interaction.user.id);
  if (balance < 1) {
    pendingLinks.delete(pendingLinkKey(interaction.guildId, interaction.user.id));
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "You no longer have enough link balance. Use `/redeem` to add balance.",
        ),
      ],
    });
    return;
  }

  const { consoleUsername } = pending;

  const linkResult = await linkUbisoftAccount({
    platform,
    consoleUsername,
    ubisoftEmail,
    ubisoftPassword,
  });

  if (!linkResult.ok) {
    pendingLinks.delete(pendingLinkKey(interaction.guildId, interaction.user.id));
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Failed to link your account with Ubisoft: ${linkResult.reason}`,
        ),
      ],
    });
    return;
  }

  pendingLinks.delete(pendingLinkKey(interaction.guildId, interaction.user.id));

  const newBalance = await modifyBalance(
    interaction.guildId,
    interaction.user.id,
    -1,
  );
  await db.insert(consoleLinksTable).values({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    platform,
    consoleUsername,
  });

  const config = await getGuildConfig(interaction.guildId);
  const tutorialUrl =
    platform === "xbox" ? config?.xboxTutorialUrl : config?.psnTutorialUrl;

  const platformName = platform === "xbox" ? "Xbox" : "PlayStation";

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🎮 Console Linked!`)
    .setDescription(
      `Your **${platformName}** account has been successfully linked.\n\n` +
        `**Account:** \`${consoleUsername}\`\n` +
        `**Remaining Balance:** ${newBalance}`,
    );

  if (tutorialUrl) {
    embed.addFields({
      name: "📺 Next Steps",
      value: `Watch the tutorial to complete your setup:\n${tutorialUrl}`,
    });
  } else {
    embed.addFields({
      name: "📺 Next Steps",
      value:
        "Check with your server admin for further setup instructions.",
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ─── Bot Bootstrap ───────────────────────────────────────────────────────────

export async function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN is not set. Add it to your .env file.",
    );
  }

  // Decode the application/client ID from the bot token
  const clientId = Buffer.from(token.split(".")[0], "base64").toString(
    "ascii",
  );
  if (!clientId) {
    throw new Error(
      "Could not decode client ID from DISCORD_BOT_TOKEN — check the token is valid.",
    );
  }

  // Register slash commands globally
  const rest = new REST({ version: "10" }).setToken(token);
  console.log(`[Bot] Registering slash commands for client ${clientId}...`);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[Bot] Slash commands registered globally.");

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("clientReady", (c) => {
    console.log(`[Bot] Logged in as ${c.user.tag}`);
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case "link":          await handleLink(interaction); break;
          case "redeem":        await handleRedeem(interaction); break;
          case "genkey":        await handleGenkey(interaction); break;
          case "injectkeys":    await handleInjectkeys(interaction); break;
          case "balance":       await handleBalance(interaction); break;
          case "keys":          await handleKeys(interaction); break;
          case "uninjectkeys":  await handleUninjectkeys(interaction); break;
          case "sellsetup":     await handleSellsetup(interaction); break;
          case "setchannel":    await handleSetchannel(interaction); break;
          case "removekey":     await handleRemovekey(interaction); break;
          case "checkkey":      await handleCheckkey(interaction); break;
          case "removebalance": await handleRemovebalance(interaction); break;
          case "settutorial":   await handleSettutorial(interaction); break;
        }
      } else if (interaction.isStringSelectMenu()) {
        await handleSelectMenu(interaction);
      } else if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
      }
    } catch (err) {
      console.error("[Bot] Unhandled interaction error:", err);
      try {
        const errEmbed = errorEmbed("Something went wrong. Please try again.");
        if (interaction.isRepliable()) {
          if (
            (interaction as any).replied ||
            (interaction as any).deferred
          ) {
            await (interaction as any).editReply({ embeds: [errEmbed] });
          } else {
            await (interaction as any).reply({
              embeds: [errEmbed],
              flags: 64,
            });
          }
        }
      } catch (_) {}
    }
  });

  await client.login(token);
}
