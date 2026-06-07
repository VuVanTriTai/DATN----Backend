// src/scripts/testAdaptiveQuiz.js
require("dotenv").config();
const mongoose = require("mongoose");
const Lesson = require("../models/Lesson");
const { generateQuizPool, selectQuestionsAdaptive } = require("../services/lessonQuizService");

const runTest = async () => {
  try {
    console.log("🔌 Connecting to DB...");
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/datn");
    console.log("✅ DB Connected.");

    // Lấy một lesson bất kỳ có content để test
    const lesson = await Lesson.findOne({ content: { $exists: true, $ne: "" } });
    if (!lesson) {
      console.warn("⚠️ Không tìm thấy bài học nào có content để test. Vui lòng tạo lộ trình trước.");
      process.exit(0);
    }

    console.log(`\n=========================================\nTESTING LESSON: "${lesson.title}"\n=========================================`);

    // 1. Sinh pool câu hỏi
    console.log("\n1. Generating Quiz Pool...");
    const pool = await generateQuizPool(lesson._id);
    console.log(`✅ Pool generated: ${pool.length} câu.`);
    if (pool.length > 0) {
      console.log("- Câu đầu tiên trong pool:", pool[0].question);
    }

    // 2. Chọn câu hỏi thích nghi lần 1
    console.log("\n2. Selecting Adaptive Questions (First time)...");
    const questions1 = await selectQuestionsAdaptive(lesson._id, "INTERMEDIATE", 5);
    console.log(`✅ Selected: ${questions1.length} câu.`);
    console.log("- Lần 1, câu hỏi thứ 1:", questions1[0]?.question);

    // 3. Chọn câu hỏi thích nghi lần 2 (để kiểm tra xem có bị nhảy câu hỏi hay không)
    console.log("\n3. Selecting Adaptive Questions (Second time - should be identical)...");
    const questions2 = await selectQuestionsAdaptive(lesson._id, "INTERMEDIATE", 5);
    console.log(`✅ Selected: ${questions2.length} câu.`);
    console.log("- Lần 2, câu hỏi thứ 1:", questions2[0]?.question);

    const isIdentical = questions1[0]?.question === questions2[0]?.question;
    console.log(`\n📊 KẾT QUẢ ĐỒNG BỘ: ${isIdentical ? "HOÀN HẢO (Không bị nhảy câu)" : "THẤT BẠI (Bị nhảy câu)"}`);

    if (!isIdentical) {
      throw new Error("Lỗi: Quiz bị nhảy câu hỏi giữa các lần gọi API!");
    }

    process.exit(0);
  } catch (err) {
    console.error("❌ Test failed:", err);
    process.exit(1);
  }
};

runTest();
