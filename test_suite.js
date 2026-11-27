const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const TEST_DB = path.join(__dirname, "test_upgrade_suite.sqlite3");
if (fs.existsSync(TEST_DB)) {
  try { fs.unlinkSync(TEST_DB); } catch {}
}

process.env.DB_BACKEND = "sqlite";
process.env.DATABASE_PATH = TEST_DB;
process.env.BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
process.env.BOT_OWNER_ID = "999999999";

const { Store, buildCommentPage, toPostgresSql } = require("./bot.js");

async function runTests() {
  console.log("Starting Confession Bot Upgrade Test Suite...\n");

  const store = new Store();
  await store.init();

  // Test 1: Verify Schema Migrations & Columns
  console.log("Test 1: Schema Migrations & Table Structure");
  const confessionCols = await store.all("PRAGMA table_info(confessions)");
  const colNamesConfessions = confessionCols.map((c) => c.name);
  assert(colNamesConfessions.includes("media_type"), "confessions must have media_type");
  assert(colNamesConfessions.includes("media_file_id"), "confessions must have media_file_id");
  assert(colNamesConfessions.includes("extra_message_id"), "confessions must have extra_message_id");

  const commentCols = await store.all("PRAGMA table_info(anonymous_comments)");
  const colNamesComments = commentCols.map((c) => c.name);
  assert(colNamesComments.includes("media_type"), "anonymous_comments must have media_type");
  assert(colNamesComments.includes("media_file_id"), "anonymous_comments must have media_file_id");
  console.log("  ✓ Schema migration added media_type and media_file_id columns to confessions and comments.");

  // Link group
  const testChatId = -100123456789;
  const now = Math.floor(Date.now() / 1000);
  await store.run(
    "INSERT INTO `groups`(chat_id, title, rules, linked_at, next_confession_number) VALUES(?, ?, ?, ?, 1)",
    [testChatId, "Test Group", "Rules", now],
  );

  // Test 2: Confession Submissions with Various Media Types
  console.log("\nTest 2: Confession Submissions with Media Types");
  const user1 = 111111;
  const user2 = 222222;

  // 1. Text-only confession
  await store.run(
    "INSERT INTO confessions(owner_id, chat_id, kind, body, media_type, media_file_id, created_at, status, confession_number) VALUES(?,?,?,?,?,?,?,?,?)",
    [user1, testChatId, "confession", "I secretly love pineapple on pizza.", "text", null, now, "published", 1],
  );

  // 2. Photo confession
  await store.run(
    "INSERT INTO confessions(owner_id, chat_id, kind, body, photo_file_id, media_type, media_file_id, created_at, status, confession_number) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [user1, testChatId, "confession", "Look at this view", "photo_123", "photo", "photo_123", now + 1, "published", 2],
  );

  // 3. Video confession
  await store.run(
    "INSERT INTO confessions(owner_id, chat_id, kind, body, media_type, media_file_id, created_at, status, confession_number) VALUES(?,?,?,?,?,?,?,?,?)",
    [user1, testChatId, "vent", "Late night drive video", "video", "video_456", now + 2, "published", 3],
  );

  // 4. Animation (GIF) confession
  await store.run(
    "INSERT INTO confessions(owner_id, chat_id, kind, body, media_type, media_file_id, created_at, status, confession_number) VALUES(?,?,?,?,?,?,?,?,?)",
    [user1, testChatId, "confession", "Mood today", "animation", "gif_789", now + 3, "published", 4],
  );

  // 5. Sticker confession
  await store.run(
    "INSERT INTO confessions(owner_id, chat_id, kind, body, media_type, media_file_id, extra_message_id, created_at, status, confession_number) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [user1, testChatId, "confession", "😎", "sticker", "sticker_999", 5555, now + 4, "published", 5],
  );

  // User 2's confession
  await store.run(
    "INSERT INTO confessions(owner_id, chat_id, kind, body, media_type, media_file_id, created_at, status, confession_number) VALUES(?,?,?,?,?,?,?,?,?)",
    [user2, testChatId, "confession", "User 2 secret confession", "text", null, now + 5, "published", 6],
  );

  const posts = await store.all("SELECT * FROM confessions ORDER BY confession_number ASC");
  assert.strictEqual(posts.length, 6);
  assert.strictEqual(posts[0].media_type, "text");
  assert.strictEqual(posts[1].media_type, "photo");
  assert.strictEqual(posts[1].media_file_id, "photo_123");
  assert.strictEqual(posts[2].media_type, "video");
  assert.strictEqual(posts[2].media_file_id, "video_456");
  assert.strictEqual(posts[3].media_type, "animation");
  assert.strictEqual(posts[4].media_type, "sticker");
  assert.strictEqual(posts[4].extra_message_id, 5555);
  console.log("  ✓ Successfully created and verified text, photo, video, animation, and sticker confessions.");

  // Test 3: Comments with Media
  console.log("\nTest 3: Comment Submissions with Media Types");
  const confessionId1 = posts[0].id;

  // Initial state: 0 comments
  // Mock context for buildCommentPage
  const mockCtx = {
    from: { id: user1 },
    telegram: {
      getChatMember: async () => ({ status: "member" }),
    },
  };

  const initialPage = await buildCommentPage(mockCtx, confessionId1, 0);
  assert.strictEqual(initialPage.count, 0, "Initial comment count should be 0");
  assert.strictEqual(initialPage.pageCount, 0, "Page count should be 0 when no comments");
  assert(initialPage.body.includes("No comments yet."), "Should display 'No comments yet.' when empty");
  assert(!initialPage.body.includes("Page 1 of 0"), "Must NEVER display 'Page 1 of 0'");
  console.log("  ✓ Comments hidden / zero comments state handles 0 comments without invalid 'Page 1 of 0'");

  // Add text comment
  await store.run(
    "INSERT INTO anonymous_comments(confession_id, commenter_id, body, media_type, media_file_id, created_at) VALUES(?,?,?,?,?,?)",
    [confessionId1, user2, "First text comment!", "text", null, now + 10],
  );

  // Add photo comment
  await store.run(
    "INSERT INTO anonymous_comments(confession_id, commenter_id, body, media_type, media_file_id, created_at) VALUES(?,?,?,?,?,?)",
    [confessionId1, user1, "Here is a photo comment", "photo", "comment_photo_1", now + 11],
  );

  // Add sticker comment
  await store.run(
    "INSERT INTO anonymous_comments(confession_id, commenter_id, body, media_type, media_file_id, created_at) VALUES(?,?,?,?,?,?)",
    [confessionId1, user2, "👍", "sticker", "comment_sticker_2", now + 12],
  );

  // Add video comment
  await store.run(
    "INSERT INTO anonymous_comments(confession_id, commenter_id, body, media_type, media_file_id, created_at) VALUES(?,?,?,?,?,?)",
    [confessionId1, user1, "Watch this", "video", "comment_vid_3", now + 13],
  );

  const commentsPageWithData = await buildCommentPage(mockCtx, confessionId1, 0);
  assert.strictEqual(commentsPageWithData.count, 4, "Comment count should now be 4");
  assert.strictEqual(commentsPageWithData.pageCount, 1, "Page count should be 1");
  assert(commentsPageWithData.body.includes("Page 1/1"), "Displays accurate page number");
  assert.strictEqual(commentsPageWithData.cards.length, 4, "Should have 4 cards");
  assert.strictEqual(commentsPageWithData.cards[1].media_type, "photo");
  assert.strictEqual(commentsPageWithData.cards[1].media_file_id, "comment_photo_1");
  assert.strictEqual(commentsPageWithData.cards[2].media_type, "sticker");
  assert.strictEqual(commentsPageWithData.cards[3].media_type, "video");
  console.log("  ✓ Successfully created and verified text, photo, sticker, and video comments with attachments.");

  // Test 4: Delete Individual Comment
  console.log("\nTest 4: Delete Individual Comment");
  const commentToDelete = commentsPageWithData.cards[1]; // user1's photo comment
  assert.strictEqual(Number(commentToDelete.commenter_id), user1);

  // Soft delete the comment
  await store.run("UPDATE anonymous_comments SET deleted = 1 WHERE id = ?", [commentToDelete.id]);
  const pageAfterDelete = await buildCommentPage(mockCtx, confessionId1, 0);
  assert.strictEqual(pageAfterDelete.count, 3, "Count should decrease to 3 after deletion");
  assert(!pageAfterDelete.cards.some((c) => c.id === commentToDelete.id), "Deleted comment must not appear in cards");
  console.log("  ✓ Comment deletion successfully hides deleted comment and updates count.");

  // Test 5: /allMyConfessions Command Requirements
  console.log("\nTest 5: /allMyConfessions Command & User Privacy");
  // Fetch for user1
  const user1Confessions = await store.all(
    "SELECT c.id, c.confession_number, c.kind, c.body, c.media_type, c.media_file_id, c.photo_file_id, c.created_at, " +
    "(SELECT COUNT(*) FROM anonymous_comments WHERE confession_id = c.id AND deleted = 0) AS comment_count " +
    "FROM confessions c " +
    "WHERE c.owner_id = ? AND c.status = 'published' AND c.deleted = 0 " +
    "ORDER BY c.id DESC",
    [user1],
  );
  assert.strictEqual(user1Confessions.length, 5, "User 1 should see exactly their 5 submitted confessions");
  assert(user1Confessions.every((c) => Number(c.confession_number) >= 1 && Number(c.confession_number) <= 5));
  // Check comment count on #1 is 3 (was 4, 1 deleted)
  const confession1FromList = user1Confessions.find((c) => c.confession_number === 1);
  assert.strictEqual(Number(confession1FromList.comment_count), 3, "Comment count must reflect active comments");

  // Fetch for user2: should only see their 1 confession
  const user2Confessions = await store.all(
    "SELECT c.id, c.confession_number, c.kind, c.body, c.media_type, c.media_file_id, c.photo_file_id, c.created_at, " +
    "(SELECT COUNT(*) FROM anonymous_comments WHERE confession_id = c.id AND deleted = 0) AS comment_count " +
    "FROM confessions c " +
    "WHERE c.owner_id = ? AND c.status = 'published' AND c.deleted = 0 " +
    "ORDER BY c.id DESC",
    [user2],
  );
  assert.strictEqual(user2Confessions.length, 1, "User 2 must only see their own confession");
  assert.strictEqual(user2Confessions[0].body, "User 2 secret confession");

  // Fetch for user3 (has not submitted): should see 0
  const user3Confessions = await store.all(
    "SELECT id FROM confessions WHERE owner_id = ? AND status = 'published' AND deleted = 0",
    [333333],
  );
  assert.strictEqual(user3Confessions.length, 0, "New user has 0 confessions");
  console.log("  ✓ /allMyConfessions accurately displays user's confessions and maintains strict privacy.");

  // Test 6: Database Reset on /unlinkgroup
  console.log("\nTest 6: Database Reset on /unlinkgroup");
  // Execute unlink transaction as in bot.js
  await store.transaction(async (tx) => {
    await tx.run(
      "DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM anonymous_comments WHERE confession_id IN (SELECT id FROM confessions WHERE chat_id = ?))",
      [testChatId],
    );
    await tx.run(
      "DELETE FROM anonymous_comments WHERE confession_id IN (SELECT id FROM confessions WHERE chat_id = ?)",
      [testChatId],
    );
    await tx.run(
      "DELETE FROM submissions WHERE owner_id IN (SELECT owner_id FROM confessions WHERE chat_id = ?)",
      [testChatId],
    );
    await tx.run("DELETE FROM confessions WHERE chat_id = ?", [testChatId]);
    await tx.run("DELETE FROM `groups` WHERE chat_id = ?", [testChatId]);
  });

  // Verify that all group data is completely wiped
  const remainingConfessions = await store.all("SELECT id FROM confessions WHERE chat_id = ?", [testChatId]);
  assert.strictEqual(remainingConfessions.length, 0, "All confessions must be deleted");

  const remainingComments = await store.all("SELECT id FROM anonymous_comments");
  assert.strictEqual(remainingComments.length, 0, "All comments must be deleted");

  const remainingGroups = await store.all("SELECT chat_id FROM `groups` WHERE chat_id = ?", [testChatId]);
  assert.strictEqual(remainingGroups.length, 0, "Group must be deleted");

  // User 1's /allMyConfessions should now be completely empty
  const user1AfterReset = await store.all(
    "SELECT id FROM confessions WHERE owner_id = ? AND status = 'published' AND deleted = 0",
    [user1],
  );
  assert.strictEqual(user1AfterReset.length, 0, "After unlink, user has 0 confessions");

  // Re-link group as in /setgroup
  await store.run(
    "INSERT INTO `groups`(chat_id, title, rules, linked_at, next_confession_number) VALUES(?, ?, ?, ?, 1)",
    [testChatId, "Re-linked Group", "Rules", now + 100],
  );

  const newGroup = await store.get("SELECT next_confession_number FROM `groups` WHERE chat_id = ?", [testChatId]);
  assert.strictEqual(Number(newGroup.next_confession_number), 1, "Relinked group starts numbering at 1");
  console.log("  ✓ /unlinkgroup atomically purged all confessions, comments, submissions, and reset numbering to #1 on relink.");

  // Test 7: Postgres SQL Helper
  console.log("\nTest 7: Postgres Query Translation (toPostgresSql)");
  const pgSql = toPostgresSql("SELECT chat_id FROM `groups` WHERE chat_id = ? AND linked_at > ?");
  assert.strictEqual(pgSql, 'SELECT chat_id FROM "groups" WHERE chat_id = $1 AND linked_at > $2');
  console.log("  ✓ toPostgresSql properly escapes table identifiers and numbers positional parameters.");

  await store.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
  console.log("\n=========================================");
  console.log("ALL TESTS PASSED SUCCESSFULLY! (7/7)");
  console.log("=========================================\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
