/**
 * Script: Reset LessonEmbeddings
 * Chạy một lần để xóa toàn bộ data cũ trong collection lessonembeddings.
 * Data cũ có thể không có topicText hoặc được index với $project sai.
 *
 * Usage: node scripts/resetLessonEmbeddings.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const LessonEmbedding = require("../src/models/LessonEmbedding");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✅ Connected to MongoDB");

  const count = await LessonEmbedding.countDocuments();
  console.log(`📊 Hiện có ${count} LessonEmbedding documents`);

  const result = await LessonEmbedding.deleteMany({});
  console.log(`🗑️  Đã xóa ${result.deletedCount} documents`);

  await mongoose.disconnect();
  console.log("✅ Done. Hãy tạo lại khóa học để re-index.");
}

main().catch(console.error);
