// ─────────────────────────────────────────────────────────────────────────────
// debug_lessons.js
//
// Script debug: Xuất nội dung tất cả các ngày học trong khoá học ra file .txt
// để dễ đọc và kiểm tra, tương tự debug_extracted.txt.
//
// Cách dùng:
//   node debug_lessons.js                        → Xuất TẤT CẢ plan
//   PLAN_ID=xxx node debug_lessons.js            → Xuất 1 plan cụ thể
//   SHOW_QUIZ=true node debug_lessons.js         → Hiện thêm câu hỏi quiz
//   OUTPUT=my_file.txt node debug_lessons.js     → Tên file output tuỳ chỉnh
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const fs       = require("fs");
const path     = require("path");

const Plan   = require("./src/models/Plan");
const Lesson = require("./src/models/Lesson");

// ── Config ────────────────────────────────────────────────────────────────────
const PLAN_ID   = process.env.PLAN_ID   || null;
const SHOW_QUIZ = process.env.SHOW_QUIZ === "true";
const OUTPUT    = process.env.OUTPUT    || "debug_lessons.txt";

const DEBUG_DIR = path.join(__dirname, "src", "debug");
const OUT_PATH  = path.join(DEBUG_DIR, OUTPUT);

// ── Helpers ───────────────────────────────────────────────────────────────────
const line  = (char = "─", len = 80) => char.repeat(len);
const DLINE = line("═");
const SLINE = line("─");

const pad2 = (n) => String(n).padStart(2, "0");

const timestamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// ── Main ──────────────────────────────────────────────────────────────────────
const run = async () => {
  // 1. Kết nối DB
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ Thiếu MONGODB_URI / MONGO_URI trong .env");
    process.exit(1);
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 30000,
  });
  console.log("✅ Đã kết nối MongoDB");

  // 2. Lấy danh sách Plan
  const planQuery = { isDeleted: false };
  if (PLAN_ID) {
    planQuery._id = new mongoose.Types.ObjectId(PLAN_ID);
    console.log(`🔍 Lọc theo plan: ${PLAN_ID}`);
  }

  const plans = await Plan.find(planQuery)
    .populate("owner", "fullName email")
    .sort({ createdAt: -1 })
    .lean();

  if (plans.length === 0) {
    console.log("⚠️  Không tìm thấy khoá học nào.");
    await mongoose.disconnect();
    return;
  }

  console.log(`📚 Tìm thấy ${plans.length} khoá học. Đang xuất...`);

  // 3. Xây dựng nội dung file
  const lines = [];

  lines.push(DLINE);
  lines.push(`  DEBUG LESSONS — Nội dung các ngày học trong khoá học`);
  lines.push(`  Xuất lúc: ${timestamp()}`);
  lines.push(`  Tổng khoá học: ${plans.length}`);
  if (PLAN_ID) lines.push(`  Lọc Plan ID: ${PLAN_ID}`);
  lines.push(DLINE);
  lines.push("");

  let totalLessons = 0;

  for (let pi = 0; pi < plans.length; pi++) {
    const plan = plans[pi];

    // Lấy tất cả bài học của plan, sắp xếp theo ngày
    const lessons = await Lesson.find({ planId: plan._id, isDeleted: false })
      .sort({ dayNumber: 1 })
      .lean();

    const owner = plan.owner
      ? `${plan.owner.fullName || "?"} <${plan.owner.email || "?"}>`
      : "N/A";

    // ── Header khoá học ──────────────────────────────────────────────────────
    lines.push(DLINE);
    lines.push(`  KHOÁ HỌC #${pi + 1}: ${plan.title || "(Không tên)"}`);
    lines.push(DLINE);
    lines.push(`  ID          : ${plan._id}`);
    lines.push(`  Chủ sở hữu  : ${owner}`);
    lines.push(`  Chủ đề      : ${plan.topic || "(chưa có)"}`);
    lines.push(`  Thời lượng  : ${plan.duration || "?"} ngày`);
    lines.push(`  Trình độ    : ${plan.level || "?"}`);
    lines.push(`  Focus       : ${plan.learningFocus || "?"} / Depth: ${plan.learningDepth || "?"}`);
    lines.push(`  Nguồn       : ${plan.sourceType || "self"}`);
    lines.push(`  Trạng thái  : ${plan.status || "pending"}`);
    lines.push(`  Tạo lúc     : ${plan.createdAt ? new Date(plan.createdAt).toLocaleString("vi-VN") : "?"}`);
    lines.push(`  Số bài học  : ${lessons.length}`);
    lines.push("");

    if (lessons.length === 0) {
      lines.push("  ⚠️  Khoá học này chưa có bài học nào.");
      lines.push("");
      continue;
    }

    // ── Từng ngày học ─────────────────────────────────────────────────────────
    for (const lesson of lessons) {
      totalLessons++;

      const statusIcon = {
        "locked":      "🔒",
        "in-progress": "▶️ ",
        "completed":   "✅",
      }[lesson.status] || "❓";

      lines.push(SLINE);
      lines.push(`  ${statusIcon} NGÀY ${lesson.dayNumber}: ${lesson.title || "(Không tên)"}`);
      lines.push(SLINE);
      lines.push(`  Lesson ID   : ${lesson._id}`);
      lines.push(`  Trạng thái  : ${lesson.status}`);
      lines.push(`  Quiz type   : ${lesson.quizType || "main"}`);
      lines.push(`  Quiz pool   : ${(lesson.quizPool || []).length} câu`);
      lines.push(`  Video URL   : ${lesson.videoUrl || "(chưa có)"}`);
      lines.push(`  Assignment  : ${lesson.assignmentUrl || "(chưa có)"}`);
      lines.push(`  Solution    : ${lesson.solutionUrl || "(chưa có)"}`);
      lines.push("");

      // Summary
      if (lesson.summary) {
        lines.push("  ── TÓM TẮT ──");
        lines.push(lesson.summary.trim().split("\n").map(l => "  " + l).join("\n"));
        lines.push("");
      }

      // Important Notes
      if (Array.isArray(lesson.importantNotes) && lesson.importantNotes.length > 0) {
        lines.push("  ── LƯU Ý QUAN TRỌNG ──");
        lesson.importantNotes.forEach((note, i) => {
          lines.push(`  [${i + 1}] ${note}`);
        });
        lines.push("");
      }

      // Content
      lines.push("  ── NỘI DUNG BÀI HỌC ──");
      lines.push("");
      if (lesson.content) {
        // Indent mỗi dòng nội dung 2 space
        lesson.content.trim().split("\n").forEach(l => lines.push("  " + l));
      } else {
        lines.push("  (Không có nội dung)");
      }
      lines.push("");

      // Quiz (nếu bật SHOW_QUIZ)
      if (SHOW_QUIZ) {
        const pool = lesson.quizPool || [];
        const quiz = lesson.quiz || [];
        const allQuestions = pool.length > 0 ? pool : quiz;

        if (allQuestions.length > 0) {
          lines.push("  ── QUIZ POOL ──");
          allQuestions.forEach((q, i) => {
            lines.push(`  [Q${i + 1}] (${q.difficulty || "?"} / ${q.bloomLevel || "?"}) ${q.question}`);
            if (Array.isArray(q.options)) {
              q.options.forEach((opt, oi) => {
                const mark = oi === q.correctAnswer ? "✓" : " ";
                lines.push(`     ${mark} ${oi + 1}. ${opt}`);
              });
            }
            if (q.explanation) {
              lines.push(`     💡 ${q.explanation}`);
            }
            lines.push("");
          });
        }
      }
    }

    lines.push(""); // Khoảng cách giữa các plan
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push(DLINE);
  lines.push(`  TỔNG KẾT`);
  lines.push(DLINE);
  lines.push(`  Khoá học  : ${plans.length}`);
  lines.push(`  Bài học   : ${totalLessons}`);
  lines.push(`  Xuất lúc  : ${timestamp()}`);
  lines.push(DLINE);

  // 4. Ghi file
  if (!fs.existsSync(DEBUG_DIR)) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  }

  const content = lines.join("\n");
  fs.writeFileSync(OUT_PATH, content, "utf-8");

  console.log("");
  console.log(`✅ Đã xuất thành công!`);
  console.log(`   📄 File    : ${OUT_PATH}`);
  console.log(`   📚 Plans   : ${plans.length}`);
  console.log(`   📖 Lessons : ${totalLessons}`);
  console.log(`   📦 Size    : ${(Buffer.byteLength(content, "utf-8") / 1024).toFixed(1)} KB`);
  console.log("");
  console.log("💡 Tips:");
  console.log("   PLAN_ID=<id>        → Chỉ xuất 1 plan");
  console.log("   SHOW_QUIZ=true      → Hiện nội dung quiz pool");
  console.log("   OUTPUT=custom.txt   → Đổi tên file output");
  console.log("");

  await mongoose.disconnect();
  console.log("👋 Đã ngắt kết nối MongoDB.");
};

run().catch((err) => {
  console.error("💥 Script lỗi:", err.message);
  process.exit(1);
});
