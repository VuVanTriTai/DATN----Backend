// scripts/seedQuizPools.js
// ─────────────────────────────────────────────────────────────────────────────
// Script chạy MỘT LẦN để sinh quiz pool cho tất cả bài học đã có trong DB.
// Mỗi bài học sẽ được gọi AI (Groq) → sinh 20 câu → lưu vào lesson.quizPool.
//
// Chạy:
//   node src/scripts/seedQuizPools.js
//
// Tuỳ chọn env:
//   BATCH_SIZE=3      node src/scripts/seedQuizPools.js  (mặc định 3 — tránh rate limit Groq)
//   DELAY_MS=15000    node src/scripts/seedQuizPools.js  (mặc định 15s delay giữa mỗi batch)
//   PLAN_ID=xxx       node src/scripts/seedQuizPools.js  (chỉ chạy cho 1 plan cụ thể)
//   FORCE=true        node src/scripts/seedQuizPools.js  (ghi đè pool đã có)
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const Lesson = require("../models/Lesson");
const { generateQuizPool } = require("../services/lessonQuizService");

// ── Cấu hình ─────────────────────────────────────────────────────────────────
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "3",     10);
const DELAY_MS   = parseInt(process.env.DELAY_MS   || "15000", 10); // 15s — tránh rate limit
const PLAN_ID    = process.env.PLAN_ID  || null;   // Lọc theo plan cụ thể (optional)
const FORCE      = process.env.FORCE === "true";   // Ghi đè pool đã có

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Hiển thị thanh tiến độ đơn giản ─────────────────────────────────────────
const progressBar = (done, total, barLen = 30) => {
  const filled = Math.round((done / total) * barLen);
  return "[" + "█".repeat(filled) + "░".repeat(barLen - filled) + `] ${done}/${total}`;
};

// ── Main ──────────────────────────────────────────────────────────────────────
const run = async () => {
  // 1. Kết nối DB
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log("✅ Đã kết nối MongoDB\n");

  // 2. Xây dựng query
  const query = {
    isDeleted: { $ne: true },
    // Chỉ xử lý bài chính (không phải remedial/advanced)
    $or: [
      { quizType: "main" },
      { quizType: { $exists: false } },
    ],
  };

  // Nếu chỉ định PLAN_ID → chạy cho 1 plan
  if (PLAN_ID) {
    query.planId = new mongoose.Types.ObjectId(PLAN_ID);
    console.log(`🔍 Chỉ xử lý plan: ${PLAN_ID}`);
  }

  // Nếu không FORCE → bỏ qua bài đã có pool đủ câu
  if (!FORCE) {
    query.$and = [
      {
        $or: [
          { quizPool: { $exists: false } },
          { quizPool: { $size: 0 } },
          { "quizPool.4": { $exists: false } }, // pool < 5 câu
        ],
      },
    ];
  }

  const lessons = await Lesson.find(query)
    .select("_id planId title quizPool")
    .lean();

  const total = lessons.length;

  if (total === 0) {
    console.log("✅ Tất cả bài học đã có quiz pool. Không cần chạy lại.");
    await mongoose.disconnect();
    return;
  }

  console.log(`📚 Tìm thấy ${total} bài học cần sinh quiz pool.`);
  if (!FORCE) console.log("   (Bỏ qua bài đã có pool. Dùng FORCE=true để ghi đè)\n");
  console.log(`⚙️  Cấu hình: batch=${BATCH_SIZE} câu/nhóm | delay=${DELAY_MS / 1000}s\n`);
  console.log("─".repeat(60));

  // 3. Xử lý từng batch
  let success = 0;
  let failed  = 0;
  let skipped = 0;

  for (let i = 0; i < lessons.length; i += BATCH_SIZE) {
    const batch = lessons.slice(i, i + BATCH_SIZE);

    // Xử lý tuần tự trong batch (tránh gọi Groq quá nhiều song song)
    for (const lesson of batch) {
      const label = `  Ngày? | "${lesson.title.substring(0, 45)}"`;

      try {
        // Bỏ qua nếu đã đủ pool và không FORCE
        if (!FORCE && lesson.quizPool && lesson.quizPool.length >= 5) {
          console.log(`   ⏩ BỎ QUA (đã có ${lesson.quizPool.length} câu): ${lesson.title}`);
          skipped++;
          continue;
        }

        console.log(`   🤖 Đang sinh... ${label}`);
        const questions = await generateQuizPool(String(lesson._id));

        // Phân loại theo độ khó để hiển thị stats
        const easy   = questions.filter(q => q.difficulty === "easy").length;
        const medium = questions.filter(q => q.difficulty === "medium").length;
        const hard   = questions.filter(q => q.difficulty === "hard").length;

        console.log(
          `   ✅ Thành công! ${questions.length} câu ` +
          `(dễ:${easy} | tb:${medium} | khó:${hard})`
        );
        success++;

      } catch (err) {
        console.error(`   ❌ LỖI: "${lesson.title}" → ${err.message}`);
        failed++;
      }
    }

    // Hiển thị tiến độ sau mỗi batch
    const done = Math.min(i + BATCH_SIZE, total);
    console.log(`\n${progressBar(done, total)} | ✅ ${success} | ❌ ${failed} | ⏩ ${skipped}\n`);

    // Delay giữa các batch (tránh rate limit Groq)
    if (done < total) {
      console.log(`   ⏳ Chờ ${DELAY_MS / 1000}s trước batch tiếp theo...\n`);
      await sleep(DELAY_MS);
    }
  }

  // 4. Tổng kết
  console.log("─".repeat(60));
  console.log(`\n🏁 HOÀN TẤT`);
  console.log(`   ✅ Thành công : ${success} bài`);
  console.log(`   ⏩ Bỏ qua    : ${skipped} bài (đã có pool)`);
  console.log(`   ❌ Thất bại  : ${failed} bài`);

  if (failed > 0) {
    console.log(`\n💡 Chạy lại để retry các bài thất bại:`);
    console.log(`   node src/scripts/seedQuizPools.js`);
  }

  await mongoose.disconnect();
  console.log("\n👋 Đã ngắt kết nối MongoDB.\n");
};

run().catch((err) => {
  console.error("💥 Script thất bại:", err);
  process.exit(1);
});
