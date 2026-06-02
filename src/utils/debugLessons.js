"use strict";

const fs   = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const DEBUG_DIR = path.join(__dirname, "../debug");

if (!fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
const line  = (char = "─", len = 80) => char.repeat(len);
const DLINE = line("═");
const SLINE = line("─");

const pad2 = (n) => String(n).padStart(2, "0");

const timestamp = () => {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
};

// ─────────────────────────────────────────────
// SAVE DEBUG LESSONS
// ─────────────────────────────────────────────

/**
 * Ghi toàn bộ nội dung các ngày học của một Plan ra file debug_lessons.txt
 * (Ghi đè — mỗi lần tạo khoá học mới sẽ XOÁ nội dung cũ và ghi lại từ đầu)
 *
 * @param {Object} plan    - Mongoose Plan document (hoặc plain object)
 * @param {Array}  lessons - Mảng Lesson documents đã được tạo
 */
const saveDebugLessons = (plan, lessons) => {
  try {
    const outPath = path.join(DEBUG_DIR, "debug_lessons.txt");

    const lines = [];

    lines.push("");
    lines.push(DLINE);
    lines.push(`  KHOÁ HỌC: ${plan.title || "(Không tên)"}`);
    lines.push(`  Plan ID : ${plan._id}`);
    lines.push(`  Xuất lúc: ${timestamp()}`);
    lines.push(`  Số ngày : ${lessons.length}`);
    lines.push(DLINE);
    lines.push("");

    for (const lesson of lessons) {
      const statusIcon =
        lesson.status === "in-progress" ? "▶ " :
        lesson.status === "completed"   ? "✅" :
        "🔒";

      // ── Header ngày học ───────────────────────────────────────────────────
      lines.push(SLINE);
      lines.push(`  ${statusIcon} NGÀY ${lesson.dayNumber}: ${lesson.title || "(Không tên)"}`);
      lines.push(SLINE);
      lines.push(`  Lesson ID : ${lesson._id}`);
      lines.push(`  Status    : ${lesson.status}`);
      lines.push(`  Quiz type : ${lesson.quizType || "main"}`);
      lines.push(`  Quiz pool : ${(lesson.quizPool || []).length} câu`);
      lines.push("");

      // ── Summary ───────────────────────────────────────────────────────────
      if (lesson.summary) {
        lines.push("  [TÓM TẮT]");
        lesson.summary
          .trim()
          .split("\n")
          .forEach((l) => lines.push("  " + l));
        lines.push("");
      }

      // ── Important Notes ───────────────────────────────────────────────────
      if (Array.isArray(lesson.importantNotes) && lesson.importantNotes.length > 0) {
        lines.push("  [LƯU Ý QUAN TRỌNG]");
        lesson.importantNotes.forEach((note, i) => {
          lines.push(`  [${i + 1}] ${note}`);
        });
        lines.push("");
      }

      // ── Content (nội dung chính — phần quan trọng nhất) ──────────────────
      lines.push("  [NỘI DUNG BÀI HỌC]");
      lines.push("");
      if (lesson.content) {
        lesson.content
          .trim()
          .split("\n")
          .forEach((l) => lines.push("  " + l));
      } else {
        lines.push("  (Không có nội dung)");
      }
      lines.push("");
    }

    lines.push(DLINE);
    lines.push(`  KẾT THÚC KHOÁ HỌC: ${plan.title || plan._id}`);
    lines.push(DLINE);
    lines.push("");

    // Ghi đè — xoá nội dung cũ, ghi lại nội dung khoá học mới nhất
    fs.writeFileSync(outPath, lines.join("\n"), "utf-8");

    console.log(`✅ [debugLessons] Đã ghi đè ${lessons.length} bài học → src/debug/debug_lessons.txt`);
  } catch (err) {
    // Không throw — debug không được làm hỏng luồng chính
    console.warn("⚠️ [debugLessons] Ghi file thất bại:", err.message);
  }
};

module.exports = { saveDebugLessons };
