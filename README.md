# Anonymous confession and venting bot

Node.js Telegram bot. Members submit in a private chat; submissions are posted directly to the linked group without an admin approval queue.

## Setup

1. Create a bot with Telegram's BotFather and copy its token.
2. Install Node.js 24 or newer (SQLite uses Node's built-in `node:sqlite` module).
3. Run `npm install` in this folder.
4. Copy `.env.example` to `.env`, set `BOT_TOKEN`, and set `BOT_OWNER_ID` to the bot creator's numeric Telegram user ID. Message the bot privately with `/myid` to see your ID. The creator can privately use `/who <confession ID>` to look up the submitter; other users cannot use that command.
5. Start the bot with `npm start`.
6. Add the bot to the Telegram group as an administrator with permission to post and delete its messages. Membership verification uses Telegram's `getChatMember` API, which Telegram guarantees for bots that are administrators in the group. The configured bot owner must run `/setgroup` in the group. After linking, an administrator can choose to create a forum topic for confessions or keep using general chat. Topic creation requires a forum-enabled supergroup and the bot's Manage Topics permission. Members then open a private chat with the bot and use `/confess` or `/vent`.
7. In Telegram's group settings, a group admin opens Group Info > Edit > Reactions and enables reactions, then chooses which reactions members may use. The Bot API cannot change this setting.

## Docker deployment preparation

The repository includes a Dockerfile for Node.js 24 and SQLite persistence. Copy `.env.example` to `.env`, fill in `BOT_TOKEN` and `BOT_OWNER_ID`, then build and run the image with a persistent volume:

```sh
docker build -t anonymous-confession-bot .
docker volume create confession-data
docker run -d --name confession-bot --restart unless-stopped --env-file .env -v confession-data:/data anonymous-confession-bot
```

The database is stored in `/data/confessions.sqlite3` inside the container, backed by the `confession-data` volume. Keep `.env` private. For MySQL deployments, set `DB_BACKEND=mysql` and provide the `MYSQL_*` settings instead. Run only one polling instance for a bot token.

The bot automatically removes confessions, comments, comment reactions, rate-limit history, and expired pending sessions older than 21 days. It runs cleanup at startup and every 21 days while running. Set `DATA_RETENTION_DAYS` to change the retention period. Group configuration and user display names are retained. Expired group confession posts stay in Telegram, but the bot tries to remove their comment buttons before deleting their database records.

## Database

SQLite is the default and stores data in `confessions.sqlite3` (or `DATABASE_PATH`). For MySQL, create a database and user, set `DB_BACKEND=mysql`, and fill in `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DATABASE`. For Neon, set `DB_BACKEND=postgres` and use the pooled `DATABASE_URL` supplied by Neon. `PG_POOL_SIZE` controls the PostgreSQL connection pool. The bot creates its tables at startup for each backend.

The Neon adapter uses `pg` with a small reusable connection pool, which suits this long-running Node.js bot. Neon provisioning supplies the pooled application `DATABASE_URL`; use direct connection strings for administrative or migration tools. Switching the backend does not migrate the existing SQLite or MySQL records into Neon.

On startup, the bot adds nullable `topic_id` and `topic_name` columns to an existing `groups` table when they are missing. This upgrade preserves existing group rows and is applied through the configured SQLite, MySQL, or PostgreSQL backend; no separate migration command is needed. For Neon, deploy the updated bot with `DB_BACKEND=postgres` and its existing `DATABASE_URL`; startup applies the schema upgrade to Neon without copying local SQLite data.

## Commands and features

- `/start`, `/help`, `/rules`
- `/myid` in private chat shows your Telegram user ID. `/who <confession ID>` is restricted to the configured bot creator and shows the submitter's Telegram ID and profile details when available.
- `/name <name>` in private chat sets a unique display name (2–24 characters). Names are unique without regard to capitalization. Until a user chooses one, comments display as **Anonymous**.
- `/confess` and `/vent` in private chat, followed by the submission text or a photo with a caption. `/cancel` cancels a pending submission.
- Each confession has one **Read or add comment (N)** button that opens the thread in a private bot chat. The thread shows five top-level comments per page, with replies under their parent comment. **Prev** and **Next** appear in the footer beneath the comment cards. Top-level comment numbers start at `#1` separately for each confession. Reply cards show **Reply #x->#parent** above the text, with numbering starting at `#1` for each parent. The comment text appears above the author's name, badge, and net likes count; dislikes subtract from likes. Each comment card has **Reply**, **Like**, and **Dislike** buttons; a user can have one vote per comment and can change or remove it. Names include the user's net like score across all their comments. The score badge is 💧 from 5, 🌠 from 10, 🔥 from 20, 🥷 from 25 through 30, and 👼 above 30; lower and negative scores have no badge. Comments written by the confession author show only **Confessor**, without their chosen name or score. After writing a comment or reply, users confirm or cancel before it is saved. Comment text is visible in the bot's thread to group members who open it; the group post displays only the comment count. Comments are text-only. `/cancel` stops a pending comment.
- `/delete ID` in private chat, or tap **Delete my submission** on the private confirmation after posting. Only the account that submitted it can delete it.
- `/setgroup` links a group; `/unlinkgroup` unlinks it; `/setrules text` changes its rules. These commands are restricted to the configured bot owner, who must also be a group admin. After linking, choose **Create confession topic** or **Use general chat**. `/settopic` starts or repeats topic setup, `/removetopic` returns publishing to general chat, and `/grouptopic` shows the current destination. These topic commands are available to group administrators and the bot owner. Setup must be completed in the linked group; send `/cancel` to cancel or provide a topic name within ten minutes.
- Confessions use Telegram's native message reactions. Members react from their Telegram client after a group admin enables reactions in group settings. The bot does not draw custom reaction buttons or track member reaction totals.
- Members can reply normally in the group (those replies show their Telegram accounts) or use anonymous comments in the bot's private thread.

The deletion button is sent only in the submitter's private chat after a successful post. Existing group deletion buttons are rejected with a private-use instruction; ownership is checked against the database for every deletion request. Comment counts are shown on each confession's **View comments** button and update when a comment is posted.

## Privacy and abuse controls

Pending submission and comment sessions are stored in the configured database and survive bot restarts. The database stores Telegram numeric IDs for submitters to authorize deletion and commenters for rate limiting. The configured bot creator can privately use `/who <confession ID>` to identify the submitter by Telegram ID, username, and profile name when available; group members and other bot users cannot use this lookup. Profile details are captured for new submissions; older submissions only have a Telegram ID. The bot operator can access the database and submission and comment text, so restrict database access accordingly. Submissions and comments remain stored in the database. A per-account cooldown and hourly cap apply across both submissions and anonymous comments; these are basic spam controls and do not moderate content.

Telegram controls the reaction picker, available reactions, and how reactions are displayed in each client. A group admin enables and restricts reactions in Telegram's group settings. The Bot API's `setMessageReaction` method only adds, changes, or clears a reaction made by the bot itself; it cannot enable member reactions or control a user's reaction picker, so this bot does not call it. The bot also does not subscribe to native reaction updates or count member reactions.

Text is limited by `MAX_MESSAGE_LENGTH` (default 3000). Photo captions are limited to 900 characters so the bot's label fits Telegram's caption limit. The bot accepts one linked group at a time: submissions go to the most recently linked group.
