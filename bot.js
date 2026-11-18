require("dotenv").config();

const { DatabaseSync } = require("node:sqlite");
const mysql = require("mysql2/promise");
const { Pool: PostgresPool } = require("pg");
const { Telegraf, Markup, session } = require("telegraf");

const token = process.env.BOT_TOKEN;
if (!token)
  throw new Error("Set BOT_TOKEN in your environment before starting the bot.");
const botOwnerId = (process.env.BOT_OWNER_ID || "").trim();
if (botOwnerId && !/^\d+$/.test(botOwnerId))
  throw new Error("BOT_OWNER_ID must be your numeric Telegram user ID.");

const backend = (process.env.DB_BACKEND || "sqlite").toLowerCase();
const databaseUrl = process.env.DATABASE_URL;
const maxLength = Number.parseInt(process.env.MAX_MESSAGE_LENGTH || "3000", 10);
const cooldownSeconds = Number.parseInt(
  process.env.SUBMISSION_COOLDOWN_SECONDS || "60",
  10,
);
const maxPerHour = Number.parseInt(
  process.env.MAX_SUBMISSIONS_PER_HOUR || "5",
  10,
);
const dataRetentionDays = Number.parseInt(
  process.env.DATA_RETENTION_DAYS || "21",
  10,
);
if (!Number.isInteger(dataRetentionDays) || dataRetentionDays < 1)
  throw new Error("DATA_RETENTION_DAYS must be a positive whole number.");
const defaultRules =
  "Be respectful. Do not post threats, targeted harassment, identifying details, or private information about someone else. Confessions are anonymous to group members. Telegram ensures your privacy. Use /help for commands.";

const publicCommands = [
  { command: "start", description: "Get started" },
  { command: "help", description: "Show available commands" },
  { command: "confess", description: "Submit an anonymous confession" },
  { command: "vent", description: "Submit an anonymous vent" },
  { command: "cancel", description: "Cancel a pending submission" },
  { command: "myid", description: "Show your Telegram user ID" },
  { command: "name", description: "Set your display name" },
  { command: "delete", description: "Request deletion of your submission" },
  { command: "rules", description: "Show group rules" },
  { command: "comments", description: "View comments on a confession" },
  { command: "comment", description: "Add an anonymous comment" },
];

const ownerCommands = [
  { command: "setgroup", description: "Link this group" },
  { command: "unlinkgroup", description: "Unlink this group" },
  { command: "setrules", description: "Change group rules" },
];
class Store {
  constructor() {
    this.kind = backend;
    if (backend === "sqlite") {
      this.db = new DatabaseSync(
        process.env.DATABASE_PATH || "confessions.sqlite3",
      );
      this.db.exec("PRAGMA journal_mode = WAL");
    } else if (backend === "mysql") {
      this.pool = mysql.createPool({
        host: process.env.MYSQL_HOST || "127.0.0.1",
        port: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
        user: requiredEnv("MYSQL_USER"),
        password: requiredEnv("MYSQL_PASSWORD"),
        database: requiredEnv("MYSQL_DATABASE"),
        waitForConnections: true,
        connectionLimit: Number.parseInt(
          process.env.MYSQL_POOL_SIZE || "10",
          10,
        ),
      });
    } else if (backend === "postgres" || backend === "postgresql") {
      if (!databaseUrl)
        throw new Error("Set DATABASE_URL when DB_BACKEND=postgres.");
      this.kind = "postgres";
      this.pgPool = new PostgresPool({
        connectionString: databaseUrl,
        max: Number.parseInt(process.env.PG_POOL_SIZE || "5", 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
    } else {
      throw new Error("DB_BACKEND must be 'sqlite', 'mysql', or 'postgres'.");
    }
  }

  async init() {
    const statements =
      this.kind === "mysql"
        ? [
            "CREATE TABLE IF NOT EXISTS `groups` (chat_id BIGINT PRIMARY KEY, title VARCHAR(255) NOT NULL, rules TEXT NOT NULL, linked_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS confessions (id BIGINT PRIMARY KEY AUTO_INCREMENT, owner_id BIGINT NOT NULL, owner_username VARCHAR(255) NULL, owner_first_name VARCHAR(255) NULL, owner_last_name VARCHAR(255) NULL, chat_id BIGINT NOT NULL, message_id BIGINT NULL, kind VARCHAR(32) NOT NULL, body LONGTEXT NOT NULL, created_at BIGINT NOT NULL, deleted TINYINT NOT NULL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS submissions (owner_id BIGINT NOT NULL, created_at BIGINT NOT NULL, INDEX submissions_owner_time (owner_id, created_at))",
            "DROP TABLE IF EXISTS reactions",
            "CREATE TABLE IF NOT EXISTS anonymous_comments (id BIGINT PRIMARY KEY AUTO_INCREMENT, confession_id BIGINT NOT NULL, commenter_id BIGINT NOT NULL, parent_id BIGINT NULL, body LONGTEXT NOT NULL, message_id BIGINT NULL, created_at BIGINT NOT NULL, deleted TINYINT NOT NULL DEFAULT 0, INDEX comments_user_time (commenter_id, created_at), INDEX comments_thread (confession_id, parent_id, deleted))",
            "CREATE TABLE IF NOT EXISTS comment_reactions (comment_id BIGINT NOT NULL, user_id BIGINT NOT NULL, reaction VARCHAR(8) NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (comment_id, user_id))",
            "CREATE TABLE IF NOT EXISTS user_profiles (user_id BIGINT PRIMARY KEY, display_name VARCHAR(64) NOT NULL, name_key VARCHAR(64) NOT NULL UNIQUE)",
            "CREATE TABLE IF NOT EXISTS bot_sessions (session_key VARCHAR(255) PRIMARY KEY, data LONGTEXT NOT NULL, updated_at BIGINT NOT NULL)",
          ]
        : this.kind === "postgres"
          ? [
            'CREATE TABLE IF NOT EXISTS "groups" (chat_id BIGINT PRIMARY KEY, title VARCHAR(255) NOT NULL, rules TEXT NOT NULL, linked_at BIGINT NOT NULL)',
            "CREATE TABLE IF NOT EXISTS confessions (id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, owner_username VARCHAR(255), owner_first_name VARCHAR(255), owner_last_name VARCHAR(255), chat_id BIGINT NOT NULL, message_id BIGINT, kind VARCHAR(32) NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL, deleted SMALLINT NOT NULL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS submissions (owner_id BIGINT NOT NULL, created_at BIGINT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS submissions_owner_time ON submissions(owner_id, created_at)",
            "CREATE TABLE IF NOT EXISTS anonymous_comments (id BIGSERIAL PRIMARY KEY, confession_id BIGINT NOT NULL, commenter_id BIGINT NOT NULL, parent_id BIGINT, body TEXT NOT NULL, message_id BIGINT, created_at BIGINT NOT NULL, deleted SMALLINT NOT NULL DEFAULT 0)",
            "CREATE INDEX IF NOT EXISTS comments_user_time ON anonymous_comments(commenter_id, created_at)",
            "CREATE INDEX IF NOT EXISTS comments_thread ON anonymous_comments(confession_id, parent_id, deleted)",
            "CREATE TABLE IF NOT EXISTS comment_reactions (comment_id BIGINT NOT NULL, user_id BIGINT NOT NULL, reaction VARCHAR(8) NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(comment_id, user_id))",
            "CREATE TABLE IF NOT EXISTS user_profiles (user_id BIGINT PRIMARY KEY, display_name VARCHAR(64) NOT NULL, name_key VARCHAR(64) NOT NULL UNIQUE)",
            "CREATE TABLE IF NOT EXISTS bot_sessions (session_key VARCHAR(255) PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL)",
          ]
          : [
            "CREATE TABLE IF NOT EXISTS `groups` (chat_id INTEGER PRIMARY KEY, title TEXT NOT NULL, rules TEXT NOT NULL, linked_at INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS confessions (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, owner_username TEXT, owner_first_name TEXT, owner_last_name TEXT, chat_id INTEGER NOT NULL, message_id INTEGER, kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS submissions (owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS submissions_owner_time ON submissions(owner_id, created_at)",
            "DROP TABLE IF EXISTS reactions",
            "CREATE TABLE IF NOT EXISTS anonymous_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, confession_id INTEGER NOT NULL, commenter_id INTEGER NOT NULL, parent_id INTEGER, body TEXT NOT NULL, message_id INTEGER, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)",
            "CREATE INDEX IF NOT EXISTS comments_user_time ON anonymous_comments(commenter_id, created_at)",
            "CREATE TABLE IF NOT EXISTS comment_reactions (comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, reaction TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(comment_id, user_id))",
            "CREATE TABLE IF NOT EXISTS user_profiles (user_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE)",
            "CREATE TABLE IF NOT EXISTS bot_sessions (session_key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
          ];
    for (const statement of statements) await this.run(statement);
    const confessionColumns =
      this.kind === "sqlite"
        ? await this.all("PRAGMA table_info(confessions)")
        : this.kind === "mysql"
          ? await this.all("SHOW COLUMNS FROM confessions")
          : await this.all(
              "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'confessions'",
            );
    const hasConfessionColumn = (name) =>
      confessionColumns.some((column) =>
        this.kind === "mysql" ? column.Field === name : column.name === name,
      );
    const profileColumns =
      this.kind === "mysql"
        ? [
            ["owner_username", "VARCHAR(255) NULL"],
            ["owner_first_name", "VARCHAR(255) NULL"],
            ["owner_last_name", "VARCHAR(255) NULL"],
          ]
        : this.kind === "sqlite"
          ? [
            ["owner_username", "TEXT"],
            ["owner_first_name", "TEXT"],
            ["owner_last_name", "TEXT"],
          ]
          : [];
    for (const [name, type] of profileColumns) {
      if (!hasConfessionColumn(name))
        await this.run(`ALTER TABLE confessions ADD COLUMN ${name} ${type}`);
    }
    if (this.kind === "sqlite") {
      const columns = await this.all("PRAGMA table_info(`groups`)");
      if (!columns.some((column) => column.name === "linked_at")) {
        await this.run(
          "ALTER TABLE `groups` ADD COLUMN linked_at INTEGER NOT NULL DEFAULT 0",
        );
      }
    } else if (this.kind === "mysql") {
      const columns = await this.all("SHOW COLUMNS FROM `groups`");
      if (!columns.some((column) => column.Field === "linked_at")) {
        await this.run(
          "ALTER TABLE `groups` ADD COLUMN linked_at BIGINT NOT NULL DEFAULT 0",
        );
      }
    }
    const commentColumns =
      this.kind === "sqlite"
        ? await this.all("PRAGMA table_info(anonymous_comments)")
        : this.kind === "mysql"
          ? await this.all("SHOW COLUMNS FROM anonymous_comments")
          : await this.all(
              "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'anonymous_comments'",
            );
    const hasParentId =
      this.kind === "sqlite"
        ? commentColumns.some((column) => column.name === "parent_id")
        : this.kind === "mysql"
          ? commentColumns.some((column) => column.Field === "parent_id")
          : commentColumns.some((column) => column.name === "parent_id");
    if (!hasParentId) {
      await this.run(
        this.kind === "sqlite"
          ? "ALTER TABLE anonymous_comments ADD COLUMN parent_id INTEGER"
          : "ALTER TABLE anonymous_comments ADD COLUMN parent_id BIGINT NULL",
      );
    }
    if (this.kind === "sqlite" || this.kind === "postgres") {
      await this.run(
        "CREATE INDEX IF NOT EXISTS comments_thread ON anonymous_comments(confession_id, parent_id, deleted)",
      );
    }
  }

  async run(sql, params = []) {
    if (this.kind === "sqlite") return this.db.prepare(sql).run(...params);
    if (this.kind === "postgres") {
      const result = await this.pgPool.query(toPostgresSql(sql), params);
      return { rowCount: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    }
    const [result] = await this.pool.execute(sql, params);
    return result;
  }

  async get(sql, params = []) {
    if (this.kind === "sqlite") return this.db.prepare(sql).get(...params);
    if (this.kind === "postgres") {
      const result = await this.pgPool.query(toPostgresSql(sql), params);
      return result.rows[0];
    }
    const [rows] = await this.pool.execute(sql, params);
    return rows[0];
  }

  async all(sql, params = []) {
    if (this.kind === "sqlite") return this.db.prepare(sql).all(...params);
    if (this.kind === "postgres") {
      const result = await this.pgPool.query(toPostgresSql(sql), params);
      return result.rows;
    }
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async getSession(key) {
    const row = await this.get(
      "SELECT data FROM bot_sessions WHERE session_key = ?",
      [key],
    );
    if (!row) return undefined;
    try {
      return JSON.parse(row.data);
    } catch (error) {
      console.error("Discarding an invalid persisted session:", error);
      await this.deleteSession(key);
      return undefined;
    }
  }

  async setSession(key, value) {
    const data = JSON.stringify(value);
    const updatedAt = nowSeconds();
    if (this.kind === "mysql") {
      await this.run(
        "INSERT INTO bot_sessions(session_key,data,updated_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at)",
        [key, data, updatedAt],
      );
    } else {
      await this.run(
        "INSERT INTO bot_sessions(session_key,data,updated_at) VALUES(?,?,?) ON CONFLICT(session_key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
        [key, data, updatedAt],
      );
    }
  }

  async deleteSession(key) {
    await this.run("DELETE FROM bot_sessions WHERE session_key = ?", [key]);
  }

  async close() {
    if (this.kind === "sqlite") this.db.close();
    else if (this.kind === "mysql") await this.pool.end();
    else await this.pgPool.end();
  }
}

function toPostgresSql(sql) {
  let index = 0;
  return sql
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\?/g, () => `$${++index}`);
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Set ${name} when DB_BACKEND=mysql.`);
  return process.env[name];
}

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function commentsKeyboard(confessionId, count = 0) {
  const username = bot.botInfo?.username;
  return Markup.inlineKeyboard([
    [
      Markup.button.url(
        `Read or add comment (${count})`,
        `https://t.me/${username}?start=comments_${confessionId}_0`,
      ),
    ],
  ]);
}

function commentsHeaderKeyboard(confessionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Add comment", `addcomment:${confessionId}`)],
  ]);
}

function commentsPageKeyboard(confessionId, page, pageCount) {
  const navigation = [];
  if (page > 0)
    navigation.push(
      Markup.button.callback(
        "Prev",
        `commentspage:${confessionId}:${page - 1}`,
      ),
    );
  if (page < pageCount - 1)
    navigation.push(
      Markup.button.callback(
        "Next",
        `commentspage:${confessionId}:${page + 1}`,
      ),
    );
  return navigation.length ? Markup.inlineKeyboard([navigation]) : undefined;
}

function commentCardKeyboard(commentId, likes = 0, dislikes = 0) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Reply", `commentreply:${commentId}`),
      Markup.button.callback(`👍 ${likes}`, `commentlike:${commentId}`),
      Markup.button.callback(`👎 ${dislikes}`, `commentdislike:${commentId}`),
    ],
  ]);
}

function confirmCommentKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Post comment", "commentconfirm"),
      Markup.button.callback("Cancel", "commentcancel"),
    ],
  ]);
}

function privateDeleteKeyboard(confessionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Delete my submission", `delete:${confessionId}`)],
  ]);
}

function isPrivate(ctx) {
  return ctx.chat?.type === "private";
}

function isBotOwner(ctx) {
  return Boolean(botOwnerId && String(ctx.from?.id) === botOwnerId);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTelegramError(error) {
  const status = Number(error?.response?.error_code || error?.code);
  const code = String(error?.code || "");
  return (
    status === 429 ||
    status >= 500 ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(code)
  );
}

function isExpiredCallbackQueryError(error) {
  const description = String(
    error?.response?.description || error?.description || error?.message || "",
  );
  return /query is too old|response timeout expired|query id is invalid/i.test(
    description,
  );
}

function isMessageNotModifiedError(error) {
  const description = String(
    error?.response?.description || error?.description || error?.message || "",
  );
  return /message is not modified/i.test(description);
}

async function acknowledgeCallback(ctx) {
  try {
    await ctx.answerCbQuery();
    ctx.state.callbackAcknowledged = true;
  } catch (error) {
    if (!isExpiredCallbackQueryError(error)) throw error;
    // Telegram may have already expired the spinner. Continue handling the
    // action without trying to answer the same callback again in bot.catch.
    ctx.state.callbackAcknowledged = true;
  }
}

async function withTelegramRetry(operation, description, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTelegramError(error) || attempt >= attempts) throw error;
      const retryAfter = Number(
        error?.response?.parameters?.retry_after ||
          error?.parameters?.retry_after ||
          0,
      );
      const delayMs =
        retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : Math.min(1000 * 2 ** (attempt - 1), 60000);
      const retryStatus = Number.isFinite(attempts)
        ? `(${attempt}/${attempts - 1})`
        : `(attempt ${attempt})`;
      console.warn(
        `${description} failed (${error?.response?.error_code || error?.code || error?.message}); retrying in ${Math.ceil(delayMs / 1000)}s ${retryStatus}.`,
      );
      await wait(delayMs);
    }
  }
}

const store = new Store();
const bot = new Telegraf(token);

bot.use(
  session({
    defaultSession: () => ({}),
    getSessionKey: (ctx) =>
      ctx.from && ctx.chat ? `${ctx.from.id}:${ctx.chat.id}` : undefined,
    store: {
      get: (key) => store.getSession(key),
      set: (key, value) => store.setSession(key, value),
      delete: (key) => store.deleteSession(key),
    },
  }),
);

async function checkGroupMembership(ctx, chatId) {
  try {
    const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
    const allowed =
      ["creator", "administrator", "member"].includes(member.status) ||
      (member.status === "restricted" && member.is_member === true);
    return { allowed, unavailable: false };
  } catch (error) {
    console.error(
      `Could not verify membership for user ${ctx.from.id}:`,
      error,
    );
    return { allowed: false, unavailable: true };
  }
}

async function explainMembershipFailure(ctx, unavailable) {
  const message = unavailable
    ? "I could not verify your group membership. Please try again later or ask an admin to make sure I am an administrator in the group."
    : "You need to be a member of the linked group to submit. Join the group and try again.";
  return ctx.reply(message);
}

function clearPending(ctx) {
  delete ctx.session.pendingKind;
  delete ctx.session.targetChat;
  delete ctx.session.pendingCommentId;
  delete ctx.session.pendingCommentParentId;
  delete ctx.session.pendingCommentDraft;
}

async function checkRateLimit(
  userId,
  now,
  { ignoreSubmissionCooldown = false } = {},
) {
  const activity = await store.get(
    ignoreSubmissionCooldown
      ? "SELECT (SELECT MAX(created_at) FROM anonymous_comments WHERE commenter_id = ?) AS last_time, (SELECT COUNT(*) FROM submissions WHERE owner_id = ? AND created_at > ?) + (SELECT COUNT(*) FROM anonymous_comments WHERE commenter_id = ? AND created_at > ?) AS total"
      : "SELECT MAX(created_at) AS last_time, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS total FROM (SELECT created_at FROM submissions WHERE owner_id = ? UNION ALL SELECT created_at FROM anonymous_comments WHERE commenter_id = ?) AS activity",
    ignoreSubmissionCooldown
      ? [userId, userId, now - 3600, userId, now - 3600]
      : [now - 3600, userId, userId],
  );
  if (
    activity?.last_time &&
    now - Number(activity.last_time) < cooldownSeconds
  ) {
    return `Please wait ${cooldownSeconds - (now - Number(activity.last_time))} seconds before submitting again.`;
  }
  if (Number(activity?.total || 0) >= maxPerHour) {
    return "You have reached the hourly submission limit. Please try again later.";
  }
  return null;
}

bot.start(async (ctx) => {
  if (isPrivate(ctx)) {
    const payload = ctx.startPayload || "";
    const commentsMatch = /^comments_(\d+)(?:_(\d+))?$/.exec(payload);
    if (commentsMatch)
      return sendCommentList(
        ctx,
        Number(commentsMatch[1]),
        Number(commentsMatch[2] || 0),
      );
    const addCommentMatch = /^addcomment_(\d+)$/.exec(payload);
    if (addCommentMatch)
      return promptForComment(ctx, Number(addCommentMatch[1]));
    return ctx.reply(
      "Send /confess or /vent, then send your message here. I will post it anonymously in your section group. Use /delete <ID> to request removal of your post.\n\nGroup members won’t see your account. Your anonymity is protected. Your identity will remain confidential. Use /help for commands and /rules to read the group rules.",
    );
  }
  return ctx.reply(
    "Use me privately to submit an anonymous confession or vent. See /help.",
  );
});

bot.help((ctx) =>
  ctx.reply(
    "/start — get started\n/confess — submit a confession privately\n/vent — submit a vent privately\n/myid — show your Telegram user ID\n" +
      "/delete <ID> — request deletion of your submission\n/rules — show group rules\n" +
      "/comments <ID> views comments; /comment <ID> adds one anonymously; /name <name> sets your unique display name.\n" +
      "Use Telegram's built-in reactions on group posts. Use Read or add comment to open the private thread; the group shows only the comment count. Group replies display the author's Telegram account.",
  ),
);

bot.command("myid", async (ctx) => {
  if (!isPrivate(ctx)) return ctx.reply("Use /myid in a private chat with me.");
  return ctx.reply(`Your Telegram user ID is ${ctx.from.id}.`);
});

bot.command("name", async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.reply("Use /name <name> in a private chat with me.");
  const displayName = (
    ctx.message.text.split(/\s+/).slice(1).join(" ") || ""
  ).trim();
  if (!displayName) {
    const profile = await store.get(
      "SELECT display_name FROM user_profiles WHERE user_id = ?",
      [ctx.from.id],
    );
    return ctx.reply(
      `Your current name is ${profile?.display_name || "Anonymous"}. Use /name <new name> to change it.`,
    );
  }
  if (
    displayName.length < 2 ||
    displayName.length > 24 ||
    /[\r\n\u0000-\u001f\u007f]/.test(displayName)
  ) {
    return ctx.reply("Choose a name between 2 and 24 characters, on one line.");
  }
  const nameKey = displayName.toLowerCase();
  if (nameKey === "anonymous")
    return ctx.reply("Anonymous is the default name. Choose a different name.");
  const taken = await store.get(
    "SELECT user_id FROM user_profiles WHERE name_key = ?",
    [nameKey],
  );
  if (taken && Number(taken.user_id) !== Number(ctx.from.id)) {
    return ctx.reply("That name is already taken. Please choose another.");
  }
  try {
    const current = await store.get(
      "SELECT user_id FROM user_profiles WHERE user_id = ?",
      [ctx.from.id],
    );
    if (current) {
      await store.run(
        "UPDATE user_profiles SET display_name = ?, name_key = ? WHERE user_id = ?",
        [displayName, nameKey, ctx.from.id],
      );
    } else {
      await store.run(
        "INSERT INTO user_profiles(user_id,display_name,name_key) VALUES(?,?,?)",
        [ctx.from.id, displayName, nameKey],
      );
    }
  } catch (error) {
    if (
      String(error.code || "").includes("CONSTRAINT") ||
      error.code === "23505" ||
      error.code === "ER_DUP_ENTRY"
    ) {
      return ctx.reply("That name is already taken. Please choose another.");
    }
    throw error;
  }
  return ctx.reply(`Your display name is now ${displayName}.`);
});

bot.command("rules", async (ctx) => {
  const row = await store.get("SELECT rules FROM `groups` WHERE chat_id = ?", [
    ctx.chat.id,
  ]);
  return ctx.reply(row?.rules || defaultRules);
});

bot.command("setgroup", async (ctx) => {
  if (!isBotOwner(ctx)) return ctx.reply("This command is restricted to the bot owner.");
  if (!["group", "supergroup"].includes(ctx.chat.type))
    return ctx.reply("Run /setgroup inside the group you want to use.");
  const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
  if (!["administrator", "creator"].includes(member.status))
    return ctx.reply("Only a group admin can link this group.");
  const linkedAt = nowSeconds();
  if (store.kind === "mysql") {
    await store.run(
      "INSERT INTO `groups`(chat_id,title,rules,linked_at) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title), linked_at=VALUES(linked_at)",
      [ctx.chat.id, ctx.chat.title || "Telegram group", defaultRules, linkedAt],
    );
  } else {
    await store.run(
      "INSERT INTO `groups`(chat_id,title,rules,linked_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, linked_at=excluded.linked_at",
      [ctx.chat.id, ctx.chat.title || "Telegram group", defaultRules, linkedAt],
    );
  }
  return ctx.reply(
    "This group is linked. Members can now submit privately to the bot. To enable native reactions, a group admin must allow reactions in the group's Telegram settings.",
  );
});

bot.command("unlinkgroup", async (ctx) => {
  if (!isBotOwner(ctx)) return ctx.reply("This command is restricted to the bot owner.");
  if (!["group", "supergroup"].includes(ctx.chat.type))
    return ctx.reply("Run /unlinkgroup inside the currently linked group.");
  const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
  if (!["administrator", "creator"].includes(member.status))
    return ctx.reply("Only a group admin can unlink this group.");

  const linkedGroup = await store.get(
    "SELECT chat_id FROM `groups` WHERE linked_at > 0 ORDER BY linked_at DESC LIMIT 1",
  );
  if (!linkedGroup) return ctx.reply("No group is currently linked.");
  if (String(linkedGroup.chat_id) !== String(ctx.chat.id))
    return ctx.reply("This group is not currently linked to the bot.");

  await store.run("UPDATE `groups` SET linked_at = 0 WHERE linked_at > 0");
  return ctx.reply(
    "This group has been unlinked. New confessions and vents will no longer be accepted for it. Existing confessions and comments are preserved. A group admin can link a group again with /setgroup.",
  );
});

bot.command("setrules", async (ctx) => {
  if (!isBotOwner(ctx)) return ctx.reply("This command is restricted to the bot owner.");
  if (!["group", "supergroup"].includes(ctx.chat.type))
    return ctx.reply("Run /setrules <text> in the linked group.");
  const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
  const text = (ctx.message.text.split(/\s+/).slice(1).join(" ") || "").trim();
  if (!["administrator", "creator"].includes(member.status))
    return ctx.reply("Only a group admin can change the rules.");
  if (!text) return ctx.reply("Usage: /setrules <your group rules>");
  await store.run("UPDATE `groups` SET rules = ? WHERE chat_id = ?", [
    text.slice(0, 1000),
    ctx.chat.id,
  ]);
  return ctx.reply("Group rules updated.");
});

async function beginSubmission(ctx, kind) {
  if (!isPrivate(ctx))
    return ctx.reply(
      "For anonymity, start this command in a private chat with me.",
    );
  const group = await store.get(
    "SELECT chat_id, title FROM `groups` WHERE linked_at > 0 ORDER BY linked_at DESC LIMIT 1",
  );
  if (!group)
    return ctx.reply(
      "No group is linked yet. Ask a group admin to run /setgroup in the group.",
    );
  const membership = await checkGroupMembership(ctx, group.chat_id);
  if (!membership.allowed)
    return explainMembershipFailure(ctx, membership.unavailable);
  clearPending(ctx);
  ctx.session.pendingKind = kind;
  ctx.session.targetChat = group.chat_id;
  return ctx.reply(
    `Send your ${kind} as your next message. It will be posted anonymously in ${group.title}. Send /cancel to stop.`,
  );
}

async function promptForComment(ctx, confessionId, parentCommentId = null) {
  if (!isPrivate(ctx))
    return ctx.reply("Use /comment <ID> in a private chat with me.");
  const post = await store.get(
    "SELECT id, chat_id, kind, owner_id FROM confessions WHERE id = ? AND deleted = 0",
    [confessionId],
  );
  if (!post)
    return ctx.reply("I couldn't find an active confession with that ID.");
  const membership = await checkGroupMembership(ctx, post.chat_id);
  if (!membership.allowed)
    return explainMembershipFailure(ctx, membership.unavailable);

  const prompt = parentCommentId
    ? `Send your reply to comment #${parentCommentId} on #${confessionId}. It will appear under that comment in the bot's private thread. Send /cancel to stop.`
    : `Send your comment for #${confessionId} as your next message. It will be saved and shown only in the bot's private thread, not in the group. Send /cancel to stop.`;
  clearPending(ctx);
  ctx.session.pendingCommentId = confessionId;
  if (parentCommentId) ctx.session.pendingCommentParentId = parentCommentId;
  ctx.session.targetChat = post.chat_id;
  return ctx.reply(prompt);
}

async function getDisplayProfile(userId) {
  const [profile, totals] = await Promise.all([
    store.get("SELECT display_name FROM user_profiles WHERE user_id = ?", [
      userId,
    ]),
    store.get(
      "SELECT COALESCE(SUM(CASE WHEN r.reaction = 'like' THEN 1 WHEN r.reaction = 'dislike' THEN -1 ELSE 0 END), 0) AS score FROM anonymous_comments c LEFT JOIN comment_reactions r ON r.comment_id = c.id WHERE c.commenter_id = ? AND c.deleted = 0",
      [userId],
    ),
  ]);
  const score = Number(totals?.score || 0);
  let badge = "";
  if (score >= 5 && score < 10) badge = "💧";
  else if (score >= 10 && score < 20) badge = "🌠";
  else if (score >= 20 && score < 25) badge = "🔥";
  else if (score >= 25 && score <= 30) badge = "🥷";
  else if (score > 30) badge = "👼";
  return {
    name: profile?.display_name || "Anonymous",
    badge,
    score,
  };
}

async function buildCommentPage(ctx, confessionId, pageNumber = 0) {
  const post = await store.get(
    "SELECT id, chat_id, kind, body, owner_id FROM confessions WHERE id = ? AND deleted = 0",
    [confessionId],
  );
  if (!post) return { error: "This post is no longer available." };
  const membership = await checkGroupMembership(ctx, post.chat_id);
  if (!membership.allowed)
    return {
      error: membership.unavailable
        ? "I could not verify your group membership. Please try again later."
        : "Only members of this group can view comments.",
    };
  const countRow = await store.get(
    "SELECT COUNT(*) AS total FROM anonymous_comments WHERE confession_id = ? AND deleted = 0",
    [confessionId],
  );
  const roots = await store.all(
    "SELECT id, body, commenter_id FROM anonymous_comments WHERE confession_id = ? AND parent_id IS NULL AND deleted = 0 ORDER BY id ASC",
    [confessionId],
  );
  const count = Number(countRow?.total || 0);
  const pageCount = Math.max(1, Math.ceil(roots.length / 5));
  const page = Math.min(Math.max(0, pageNumber), pageCount - 1);
  const pageComments = roots.slice(page * 5, page * 5 + 5);
  const rootNumberById = new Map(
    roots.map((root, index) => [Number(root.id), index + 1]),
  );
  const cards = [];
  async function appendCommentCard(
    comment,
    depth = 0,
    replyNumber = 0,
    rootNumber = 0,
  ) {
    const number = Number(comment.id);
    const profile = await getDisplayProfile(comment.commenter_id);
    const reactions = await store.all(
      "SELECT reaction, COUNT(*) AS total FROM comment_reactions WHERE comment_id = ? GROUP BY reaction",
      [number],
    );
    const reactionCounts = Object.fromEntries(
      reactions.map((row) => [row.reaction, Number(row.total)]),
    );
    const numberLabel = depth
      ? `#${replyNumber}->#${rootNumber}`
      : `#${rootNumber}`;
    const isConfessor = Number(comment.commenter_id) === Number(post.owner_id);
    const userLabel = isConfessor
      ? "Confessor"
      : `${escapeHtml(profile.name)}${profile.badge ? ` ${profile.badge}` : ""} · Net likes: ${profile.score}`;
    cards.push({
      text: depth
        ? `<b>Reply ${numberLabel}</b>\n\n${escapeHtml(comment.body)}\n\n<b>${userLabel}</b>`
        : `<b>Comment ${numberLabel}</b>\n\n${escapeHtml(comment.body)}\n\n<b>${userLabel}</b>`,
      keyboard: commentCardKeyboard(
        number,
        reactionCounts.like || 0,
        reactionCounts.dislike || 0,
      ),
    });
    const replies = await store.all(
      "SELECT id, body, commenter_id, parent_id FROM anonymous_comments WHERE parent_id = ? AND deleted = 0 ORDER BY id ASC",
      [number],
    );
    for (let index = 0; index < replies.length; index++) {
      await appendCommentCard(
        replies[index],
        depth + 1,
        index + 1,
        rootNumber || rootNumberById.get(number),
      );
    }
  }
  for (const root of pageComments)
    await appendCommentCard(root, 0, 0, rootNumberById.get(Number(root.id)));
  const label = post.kind === "confession" ? "Confession" : "Vent";
  const heading = `<b>${label} #${confessionId}</b>\n\n${escapeHtml(post.body)}\n\n<b>Comments (${count}) · Page ${page + 1}/${pageCount}</b>`;
  const body = roots.length ? heading : `${heading}\n\nNo comments yet.`;
  return { post, body, count, page, pageCount, cards };
}

async function sendCommentList(ctx, confessionId, pageNumber = 0) {
  const page = await buildCommentPage(ctx, confessionId, pageNumber);
  if (page.error) return ctx.reply(page.error);
  try {
    if (ctx.session?.commentViewMessageIds?.length) {
      for (const messageId of ctx.session.commentViewMessageIds) {
        await ctx.telegram
          .deleteMessage(ctx.from.id, messageId)
          .catch(() => {});
      }
    }
    const messageIds = [];
    const header = await ctx.telegram.sendMessage(ctx.from.id, page.body, {
      parse_mode: "HTML",
      ...commentsHeaderKeyboard(confessionId),
    });
    messageIds.push(header.message_id);
    for (const card of page.cards) {
      const sent = await ctx.telegram.sendMessage(ctx.from.id, card.text, {
        parse_mode: "HTML",
        ...card.keyboard,
      });
      messageIds.push(sent.message_id);
    }
    const footerKeyboard = commentsPageKeyboard(
      confessionId,
      page.page,
      page.pageCount,
    );
    if (footerKeyboard) {
      const footer = await ctx.telegram.sendMessage(
        ctx.from.id,
        `Page ${page.page + 1} of ${page.pageCount}`,
        footerKeyboard,
      );
      messageIds.push(footer.message_id);
    }
    ctx.session.commentViewMessageIds = messageIds;
    return;
  } catch (error) {
    console.error(
      `Could not send comments for confession ${confessionId}:`,
      error,
    );
    const message =
      "Open a private chat with the bot first, then use /comments ID.";
    if (ctx.callbackQuery)
      return ctx.answerCbQuery(message, { show_alert: true });
    return ctx.reply(message);
  }
}

function splitTelegramText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    for (let offset = 0; offset < paragraph.length; offset += limit) {
      const piece = paragraph.slice(offset, offset + limit);
      if (piece.length === limit || offset + limit < paragraph.length)
        chunks.push(piece);
      else current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

bot.command("comments", async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.reply("Use /comments <ID> in a private chat with me.");
  const idText = ctx.message.text.split(/\s+/)[1] || "";
  if (!/^\d+$/.test(idText)) return ctx.reply("Usage: /comments <ID>.");
  const confessionId = Number(idText);
  return sendCommentList(ctx, confessionId, 0);
});

bot.action(/^commentspage:(\d+):(\d+)$/, async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.answerCbQuery("Open comments in the private bot chat.", {
      show_alert: true,
    });
  await ctx.answerCbQuery();
  return sendCommentList(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
});

bot.action(/^commentreply:(\d+)$/, async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.answerCbQuery("Reply in the private bot thread.", {
      show_alert: true,
    });
  await ctx.answerCbQuery();
  const commentId = Number(ctx.match[1]);
  const comment = await store.get(
    "SELECT confession_id FROM anonymous_comments WHERE id = ? AND deleted = 0",
    [commentId],
  );
  if (!comment) return ctx.reply("That comment is no longer available.");
  return promptForComment(ctx, Number(comment.confession_id), commentId);
});

async function toggleCommentReaction(ctx, commentId, reaction) {
  if (!isPrivate(ctx))
    return ctx.answerCbQuery(
      "Use comment reactions in the private bot thread.",
      { show_alert: true },
    );
  // Acknowledge before database and membership checks, which may take longer
  // than Telegram's callback query response window.
  await acknowledgeCallback(ctx);
  const comment = await store.get(
    "SELECT c.id, c.confession_id, f.chat_id FROM anonymous_comments c JOIN confessions f ON f.id = c.confession_id WHERE c.id = ? AND c.deleted = 0 AND f.deleted = 0",
    [commentId],
  );
  if (!comment) return ctx.reply("That comment is no longer available.");
  const membership = await checkGroupMembership(ctx, comment.chat_id);
  if (!membership.allowed)
    return ctx.reply("Only members of this group can react to comments.");
  const existing = await store.get(
    "SELECT reaction FROM comment_reactions WHERE comment_id = ? AND user_id = ?",
    [commentId, ctx.from.id],
  );
  if (existing?.reaction === reaction) {
    await store.run(
      "DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ?",
      [commentId, ctx.from.id],
    );
  } else if (store.kind === "mysql") {
    await store.run(
      "INSERT INTO comment_reactions(comment_id,user_id,reaction,created_at) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE reaction=VALUES(reaction), created_at=VALUES(created_at)",
      [commentId, ctx.from.id, reaction, nowSeconds()],
    );
  } else {
    await store.run(
      "INSERT INTO comment_reactions(comment_id,user_id,reaction,created_at) VALUES(?,?,?,?) ON CONFLICT(comment_id,user_id) DO UPDATE SET reaction=excluded.reaction, created_at=excluded.created_at",
      [commentId, ctx.from.id, reaction, nowSeconds()],
    );
  }
  const counts = await store.all(
    "SELECT reaction, COUNT(*) AS total FROM comment_reactions WHERE comment_id = ? GROUP BY reaction",
    [commentId],
  );
  const values = Object.fromEntries(
    counts.map((row) => [row.reaction, Number(row.total)]),
  );
  try {
    return await ctx.editMessageReplyMarkup(
      commentCardKeyboard(commentId, values.like || 0, values.dislike || 0)
        .reply_markup,
    );
  } catch (error) {
    if (isMessageNotModifiedError(error)) return;
    throw error;
  }
}

bot.action(/^commentlike:(\d+)$/, (ctx) =>
  toggleCommentReaction(ctx, Number(ctx.match[1]), "like"),
);
bot.action(/^commentdislike:(\d+)$/, (ctx) =>
  toggleCommentReaction(ctx, Number(ctx.match[1]), "dislike"),
);

async function refreshCommentsButton(telegram, post) {
  if (!post?.message_id) return;
  const row = await store.get(
    "SELECT COUNT(*) AS total FROM anonymous_comments WHERE confession_id = ? AND deleted = 0",
    [post.id],
  );
  try {
    await withTelegramRetry(
      () =>
        telegram.editMessageReplyMarkup(
          post.chat_id,
          post.message_id,
          undefined,
          commentsKeyboard(post.id, Number(row.total)).reply_markup,
        ),
      `Refresh comment button for confession ${post.id}`,
    );
  } catch (error) {
    if (
      !String(error.description || error.message)
        .toLowerCase()
        .includes("message is not modified")
    ) {
      console.error(
        `Could not refresh comment count for confession ${post.id}:`,
        error,
      );
    }
  }
}

async function removeOldReactionKeyboards() {
  const posts = await store.all(
    "SELECT id, chat_id, message_id FROM confessions WHERE deleted = 0 AND message_id IS NOT NULL ORDER BY id",
  );
  for (const post of posts) {
    try {
      await refreshCommentsButton(bot.telegram, post);
    } catch (error) {
      console.error(
        `Skipping comment button refresh for confession ${post.id} after retries:`,
        error,
      );
    }
    await wait(100);
  }
}

let cleanupRunning = false;

async function cleanExpiredData() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const cutoff = nowSeconds() - dataRetentionDays * 24 * 60 * 60;
    const expiredPosts = await store.all(
      "SELECT id, chat_id, message_id FROM confessions WHERE created_at < ? AND deleted = 0 AND message_id IS NOT NULL",
      [cutoff],
    );

    for (const post of expiredPosts) {
      try {
        await bot.telegram.editMessageReplyMarkup(
          post.chat_id,
          post.message_id,
          undefined,
          { inline_keyboard: [] },
        );
      } catch (error) {
        console.error(`Could not remove expired confession buttons for ${post.id}:`, error);
      }
      await wait(100);
    }

    await store.run(
      "DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM anonymous_comments WHERE created_at < ? OR confession_id IN (SELECT id FROM confessions WHERE created_at < ?))",
      [cutoff, cutoff],
    );
    await store.run(
      "DELETE FROM anonymous_comments WHERE created_at < ? OR confession_id IN (SELECT id FROM confessions WHERE created_at < ?)",
      [cutoff, cutoff],
    );
    await store.run("DELETE FROM confessions WHERE created_at < ?", [cutoff]);
    await store.run("DELETE FROM submissions WHERE created_at < ?", [cutoff]);
    await store.run("DELETE FROM bot_sessions WHERE updated_at < ?", [cutoff]);
  } finally {
    cleanupRunning = false;
  }
}

bot.command("comment", async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.reply("Use /comment <ID> in a private chat with me.");
  const idText = ctx.message.text.split(/\s+/)[1] || "";
  if (!/^\d+$/.test(idText))
    return ctx.reply(
      "Usage: /comment <ID> (the number shown on the confession). ",
    );
  return promptForComment(ctx, Number(idText));
});

bot.action(/^addcomment:(\d+)$/, async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.answerCbQuery("Open this in your private chat with the bot.", {
      show_alert: true,
    });
  await ctx.answerCbQuery();
  return promptForComment(ctx, Number(ctx.match[1]));
});

bot.command("confess", (ctx) => beginSubmission(ctx, "confession"));
bot.command("vent", (ctx) => beginSubmission(ctx, "vent"));
bot.command("cancel", async (ctx) => {
  clearPending(ctx);
  return ctx.reply("Submission cancelled.");
});

async function sendDeleteResult(ctx, text) {
  if (ctx.callbackQuery)
    return ctx.telegram
      .sendMessage(ctx.from.id, text)
      .catch(() => ctx.answerCbQuery(text, { show_alert: true }));
  return ctx.reply(text);
}

async function requestDelete(ctx, id) {
  const row = await store.get(
    "SELECT * FROM confessions WHERE id = ?",
    [id],
  );
  if (!row) {
    return sendDeleteResult(
      ctx,
      "I could not find a submission with that ID.",
    );
  }
  if (row.deleted) {
    return sendDeleteResult(
      ctx,
      "That submission has already been deleted.",
    );
  }
  const isBotOwner = botOwnerId && String(ctx.from.id) === botOwnerId;
  const isConfessor = String(row.owner_id) === String(ctx.from.id);
  if (!isBotOwner && !isConfessor)
    return sendDeleteResult(
      ctx,
      "I could not find an active submission with that ID belonging to your account.",
    );
  try {
    if (row.message_id)
      await ctx.telegram.deleteMessage(row.chat_id, row.message_id);
  } catch (error) {
    const desc = String(error?.description || error?.message || "");
    if (!/message to delete not found/i.test(desc)) {
      console.error(`Could not delete submission ${id}:`, error);
      return sendDeleteResult(
        ctx,
        "Deletion was requested, but Telegram did not let me remove the post. Please ask a group admin to remove it.",
      );
    }
  }
  await store.run("UPDATE confessions SET deleted = 1 WHERE id = ?", [id]);
  return sendDeleteResult(ctx, "Deletion successful.");
}

bot.command("delete", async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.reply("Use /delete <ID> in a private chat with me.");
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const idText = args[0] || "";
  if (!idText)
    return ctx.reply(
      "Please specify a submission ID. Usage: /delete <ID>",
    );
  if (!/^\d+$/.test(idText))
    return ctx.reply(
      "Please provide a valid numeric ID. Usage: /delete <ID>",
    );
  return requestDelete(ctx, Number(idText));
});

bot.command("who", async (ctx) => {
  try {
    if (!isPrivate(ctx)) {
      return ctx.reply("Use /who <ID> in a private chat with me.");
    }

    if (!botOwnerId || String(ctx.from.id) !== botOwnerId) {
      return ctx.reply("This command is restricted to the bot creator.");
    }

    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const idText = args[0] || "";

    if (!idText) {
      return ctx.reply("Please specify a confession ID. Usage: /who <ID>");
    }

    if (!/^\d+$/.test(idText)) {
      return ctx.reply("Please provide a valid numeric ID. Usage: /who <ID>");
    }

    const submission = await store.get(
      `SELECT id, owner_id, owner_username,
              owner_first_name, owner_last_name, kind, deleted
       FROM confessions
       WHERE id = ?`,
      [Number(idText)],
    );

    if (!submission) {
      return ctx.reply("I could not find that submission.");
    }

    const name = [submission.owner_first_name, submission.owner_last_name]
      .filter(Boolean)
      .join(" ")
      .replace(/[\r\n]+/g, " ");

    const username = submission.owner_username
      ? `@${submission.owner_username}`
      : "";

    const lines = [
      `Confession #${submission.id} Submitter Details:`,
      `User ID: ${submission.owner_id}`,
    ];
    if (name) lines.push(`Name: ${name}`);
    if (username) lines.push(`Username: ${username}`);
    if (submission.deleted) lines.push("Status: Deleted");

    return ctx.reply(lines.join("\n"));
  } catch (error) {
    console.error("[WHO ERROR]", error);
    await ctx.reply("An error occurred while looking up this confession.");
  }
});

bot.action(/^delete:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  if (!isPrivate(ctx))
    return ctx.answerCbQuery(
      "For privacy, use /delete ID in a private chat with me.",
      { show_alert: true },
    );
  await ctx.answerCbQuery();
  return requestDelete(ctx, id);
});

async function submit(ctx, body, photoFileId = null) {
  if (!isPrivate(ctx) || !ctx.session?.pendingKind) return;
  body = (body || "").trim();
  if (!body) return ctx.reply("Please send text (or a photo with a caption).");
  const allowedLength = photoFileId ? Math.min(maxLength, 900) : maxLength;
  if (body.length > allowedLength)
    return ctx.reply(
      `That message is too long. Please keep it under ${allowedLength} characters.`,
    );

  const userId = ctx.from.id;
  const now = nowSeconds();
  const limitMessage = await checkRateLimit(userId, now);
  if (limitMessage) return ctx.reply(limitMessage);

  const kind = ctx.session.pendingKind;
  const targetChat = ctx.session.targetChat;
  const linkedGroup = await store.get(
    "SELECT chat_id FROM `groups` WHERE linked_at > 0 ORDER BY linked_at DESC LIMIT 1",
  );
  if (!linkedGroup || String(linkedGroup.chat_id) !== String(targetChat)) {
    clearPending(ctx);
    return ctx.reply(
      "There is no longer a group linked for submissions. Ask a group admin to run /setgroup before submitting.",
    );
  }
  const membership = await checkGroupMembership(ctx, targetChat);
  if (!membership.allowed) {
    delete ctx.session.pendingKind;
    delete ctx.session.targetChat;
    return explainMembershipFailure(ctx, membership.unavailable);
  }
  const result = await store.run(
    `INSERT INTO confessions(owner_id,owner_username,owner_first_name,owner_last_name,chat_id,kind,body,created_at) VALUES(?,?,?,?,?,?,?,?)${store.kind === "postgres" ? " RETURNING id" : ""}`,
    [
      userId,
      ctx.from.username || null,
      ctx.from.first_name || null,
      ctx.from.last_name || null,
      targetChat,
      kind,
      body,
      now,
    ],
  );
  const id = Number(result.lastInsertRowid || result.insertId);
  await store.run("INSERT INTO submissions(owner_id,created_at) VALUES(?,?)", [
    userId,
    now,
  ]);
  const label = kind === "confession" ? "Confession" : "Vent";
  const content = `<b>${label} #${id}</b>\n\n${escapeHtml(body)}`;

  try {
    const posted = photoFileId
      ? await ctx.telegram.sendPhoto(targetChat, photoFileId, {
          caption: content,
          parse_mode: "HTML",
          ...commentsKeyboard(id, 0),
        })
      : await ctx.telegram.sendMessage(targetChat, content, {
          parse_mode: "HTML",
          ...commentsKeyboard(id, 0),
        });
    await store.run("UPDATE confessions SET message_id = ? WHERE id = ?", [
      posted.message_id,
      id,
    ]);
  } catch (error) {
    console.error(`Could not post submission ${id}:`, error);
    await store.run("UPDATE confessions SET deleted = 1 WHERE id = ?", [id]);
    return ctx.reply(
      "I could not post that right now. Please try again later or ask a group admin to check the bot’s permissions.",
    );
  }
  clearPending(ctx);
  return ctx.reply(
    `Posted anonymously as #${id}. You can delete it here at any time.`,
    privateDeleteKeyboard(id),
  );
}

async function submitComment(ctx, body) {
  if (!isPrivate(ctx) || !ctx.session?.pendingCommentId) return;
  body = (body || "").trim();
  if (!body) return ctx.reply("Please send your comment as text.");
  if (body.length > maxLength)
    return ctx.reply(
      `That comment is too long. Please keep it under ${maxLength} characters.`,
    );

  const confessionId = Number(ctx.session.pendingCommentId);
  const post = await store.get(
    "SELECT id, chat_id, message_id, owner_id FROM confessions WHERE id = ? AND deleted = 0",
    [confessionId],
  );
  if (!post) {
    clearPending(ctx);
    return ctx.reply("That confession is no longer available for comments.");
  }
  const membership = await checkGroupMembership(ctx, post.chat_id);
  if (!membership.allowed) {
    clearPending(ctx);
    return explainMembershipFailure(ctx, membership.unavailable);
  }
  const limitMessage = await checkRateLimit(ctx.from.id, nowSeconds(), {
    ignoreSubmissionCooldown: Number(post.owner_id) === Number(ctx.from.id),
  });
  if (limitMessage) return ctx.reply(limitMessage);
  ctx.session.pendingCommentDraft = body;
  const replyContext = ctx.session.pendingCommentParentId
    ? ` This is a reply to comment #${ctx.session.pendingCommentParentId}.`
    : "";
  return ctx.reply(
    `Preview your anonymous comment on #${confessionId}:${replyContext}\n\n${escapeHtml(body)}\n\nPost this comment? It will be visible in the bot to members who open the comments, and will not be posted in the group.`,
    { parse_mode: "HTML", ...confirmCommentKeyboard() },
  );
}

bot.action("commentconfirm", async (ctx) => {
  if (
    !isPrivate(ctx) ||
    !ctx.session?.pendingCommentId ||
    !ctx.session?.pendingCommentDraft
  ) {
    return ctx.answerCbQuery("There is no comment awaiting confirmation.", {
      show_alert: true,
    });
  }
  await ctx.answerCbQuery();
  const confessionId = Number(ctx.session.pendingCommentId);
  const body = ctx.session.pendingCommentDraft;
  const parentCommentId = ctx.session.pendingCommentParentId
    ? Number(ctx.session.pendingCommentParentId)
    : null;
  const post = await store.get(
    "SELECT id, chat_id, message_id, owner_id FROM confessions WHERE id = ? AND deleted = 0",
    [confessionId],
  );
  if (!post) {
    clearPending(ctx);
    return ctx.reply("That confession is no longer available for comments.");
  }
  if (parentCommentId) {
    const parent = await store.get(
      "SELECT id FROM anonymous_comments WHERE id = ? AND confession_id = ? AND deleted = 0",
      [parentCommentId, confessionId],
    );
    if (!parent) {
      clearPending(ctx);
      return ctx.reply(
        "The comment you were replying to is no longer available.",
      );
    }
  }
  const membership = await checkGroupMembership(ctx, post.chat_id);
  if (!membership.allowed) {
    clearPending(ctx);
    return explainMembershipFailure(ctx, membership.unavailable);
  }
  const limitMessage = await checkRateLimit(ctx.from.id, nowSeconds(), {
    ignoreSubmissionCooldown: Number(post.owner_id) === Number(ctx.from.id),
  });
  if (limitMessage) return ctx.reply(limitMessage);
  await store.run(
    "INSERT INTO anonymous_comments(confession_id,commenter_id,parent_id,body,created_at) VALUES(?,?,?,?,?)",
    [confessionId, ctx.from.id, parentCommentId, body, nowSeconds()],
  );
  await refreshCommentsButton(ctx.telegram, post);
  clearPending(ctx);
  return ctx.reply(
    `Your comment on #${confessionId} was posted to the bot's comments.`,
  );
});

bot.action("commentcancel", async (ctx) => {
  if (!isPrivate(ctx))
    return ctx.answerCbQuery("Use this confirmation in your private chat.", {
      show_alert: true,
    });
  await ctx.answerCbQuery("Comment cancelled.");
  delete ctx.session.pendingCommentDraft;
  delete ctx.session.pendingCommentId;
  delete ctx.session.pendingCommentParentId;
  return ctx.reply("Comment cancelled; it was not posted.");
});

bot.on("text", (ctx, next) => {
  if (ctx.message.text.startsWith("/")) return next();
  if (ctx.session?.pendingCommentId)
    return submitComment(ctx, ctx.message.text);
  return submit(ctx, ctx.message.text);
});
bot.on("photo", (ctx) => {
  const fileId = ctx.message.photo.at(-1).file_id;
  if (ctx.session?.pendingCommentId)
    return ctx.reply(
      "Anonymous comments are text-only. Please send your comment as text.",
    );
  return submit(ctx, ctx.message.caption, fileId);
});
bot.on(
  ["document", "video", "audio", "voice", "animation", "sticker"],
  (ctx) => {
    if (isPrivate(ctx) && ctx.session?.pendingKind)
      return ctx.reply(
        "Please send text or a photo with a caption. Other media is not supported.",
      );
    if (isPrivate(ctx) && ctx.session?.pendingCommentId)
      return ctx.reply("Please send your anonymous comment as text.");
  },
);

bot.catch(async (error, ctx) => {
  // These are expected when Telegram times out a callback or a retried edit
  // reaches a message whose markup was already updated.
  if (isExpiredCallbackQueryError(error) || isMessageNotModifiedError(error))
    return;
  console.error(`Bot error while handling ${ctx.updateType}:`, error);
  try {
    if (ctx.callbackQuery) {
      if (ctx.state?.callbackAcknowledged) return;
      await ctx.answerCbQuery("Something went wrong. Please try again later.", {
        show_alert: true,
      });
    } else if (isPrivate(ctx)) {
      await ctx.reply(
        "Something went wrong while handling that request. Please try again later.",
      );
    } else if (ctx.chat) {
      await ctx.reply(
        "Something went wrong while handling that command. Please try again later.",
      );
    }
  } catch (notifyError) {
    console.error("Could not send the error notice to the user:", notifyError);
  }
});

async function main() {
  await store.init();

  // A temporary Telegram/API outage should not terminate the bot process.
  // Keep waiting with capped backoff until getMe succeeds or a non-retryable
  // error (such as an invalid token) is returned.
  const me = await withTelegramRetry(
    () => bot.telegram.getMe(),
    "Telegram getMe",
    Infinity,
  );
  bot.botInfo = me;

  await bot.telegram.setMyCommands(publicCommands);
  if (botOwnerId) {
    await bot.telegram.setMyCommands(
      [...publicCommands, ...ownerCommands, { command: "who", description: "Look up a confession submitter" }],
      { scope: { type: "chat", chat_id: Number(botOwnerId) } },
    );
  }

  await cleanExpiredData();
  setInterval(() => {
    cleanExpiredData().catch((error) => {
      console.error("Scheduled database cleanup failed:", error);
    });
  }, dataRetentionDays * 24 * 60 * 60 * 1000).unref();

  const polling = bot.launch();

  removeOldReactionKeyboards().catch((error) => {
    console.error("Could not update older confession buttons:", error);
  });
  await polling;
}

main().catch(async (error) => {
  if (Number(error?.response?.error_code || error?.code) === 409) {
    console.error(
      "Telegram rejected polling because another process is already using this bot token. Stop the other bot instance, then restart this one.",
    );
  } else {
    console.error("The bot stopped during startup or polling:", error);
  }
  await store.close().catch(() => {});
  process.exitCode = 1;
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
