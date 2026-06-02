// scripts/seedLessonEmbeddings.js
// ─────────────────────────────────────────────────────────────────────────────
// Script chạy MỘT LẦN để index tất cả bài học đã tồn tại trong DB.
// Cần chạy SAU KHI tạo Atlas Search Index "lesson_vector_index".
//
// Chạy:
//   node src/scripts/seedLessonEmbeddings.js
//
// Tuỳ chọn:
//   BATCH_SIZE=50  node src/scripts/seedLessonEmbeddings.js   (mặc định 20)
//   DELAY_MS=300   node src/scripts/seedLessonEmbeddings.js   (mặc định 200)
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

// Import đủ để Mongoose register tất cả models
const Lesson          = require("../models/Lesson");
const Plan            = require("../models/Plan");
const LessonEmbedding = require("../models/LessonEmbedding");
const { indexLesson } = require("../services/lessonReuseService");

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "20", 10);
const DELAY_MS   = parseInt(process.env.DELAY_MS   || "200", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  // 1. Kết nối DB
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log("✅ Đã kết nối MongoDB");

  // 2. Lấy danh sách lessonId đã được index (để bỏ qua)
  const alreadyIndexed = new Set(
    (await LessonEmbedding.find({}, "lessonId").lean()).map((r) =>
      String(r.lessonId)
    )
  );
  console.log(`📋 Đã index trước đó: ${alreadyIndexed.size} bài`);

  // 3. Lấy tất cả bài học chưa index, không phải clone
  const lessons = await Lesson.find({
    isDeleted:   { $ne: true },
    reusedFrom:  null,
    _id:         { $nin: [...alreadyIndexed].map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select("_id planId title summary reusedFrom")
    .lean();

  console.log(`📚 Cần index: ${lessons.length} bài học`);

  if (lessons.length === 0) {
    console.log("✅ Không có bài nào cần index.");
    await mongoose.disconnect();
    return;
  }

  // 4. Lấy map planId → plan (batch, tránh N+1)
  const planIds = [...new Set(lessons.map((l) => String(l.planId)))];
  const plans   = await Plan.find({ _id: { $in: planIds } })
    .select("_id owner isPublic")
    .lean();
  const planMap = new Map(plans.map((p) => [String(p._id), p]));

  // 5. Index từng bài theo batch
  let success = 0;
  let failed  = 0;

  for (let i = 0; i < lessons.length; i += BATCH_SIZE) {
    const batch = lessons.slice(i, i + BATCH_SIZE);

    await Promise.allSettled(
      batch.map(async (lesson) => {
        const plan = planMap.get(String(lesson.planId));
        if (!plan) {
          console.warn(`   ⚠️  Không tìm thấy plan cho lesson ${lesson._id}`);
          return;
        }
        try {
          await indexLesson(lesson, plan);
          success++;
        } catch (err) {
          console.warn(`   ❌ Lỗi index "${lesson.title}":`, err.message);
          failed++;
        }
      })
    );

    const done = Math.min(i + BATCH_SIZE, lessons.length);
    console.log(`   [${done}/${lessons.length}] ✅ ${success} | ❌ ${failed}`);
    await sleep(DELAY_MS);
  }

  console.log(`\n🏁 Hoàn tất: ${success} thành công, ${failed} thất bại.`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("💥 Script thất bại:", err);
  process.exit(1);
});
