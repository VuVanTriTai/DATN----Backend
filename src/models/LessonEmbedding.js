// models/LessonEmbedding.js
// Lưu vector embedding (title + summary) của mỗi bài học đã tạo.
// Dùng để tra cứu ngữ nghĩa khi tái sử dụng bài học cho khoá học mới.
//
// ⚠️  YÊU CẦU: Tạo thủ công trên MongoDB Atlas một Vector Search Index tên
//     "lesson_vector_index" trên collection "lessonembeddings", field "embedding",
//     dimensions = 1024, similarity = cosine.
//     Filter fields cần được khai báo trong index: ownerId (token), isPublic (boolean).

const mongoose = require("mongoose");

const lessonEmbeddingSchema = new mongoose.Schema(
  {
    lessonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lesson",
      required: true,
      index: true,
      unique: true, // Mỗi lesson chỉ được index 1 lần
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Phản chiếu plan.isPublic tại thời điểm index.
    // Được cập nhật khi plan được chia sẻ lên marketplace.
    isPublic: { type: Boolean, default: false, index: true },

    // Vector 1024 chiều từ multilingual-e5-large
    embedding: { type: [Number], required: true },

    // Text gốc dùng để sinh embedding (debug / audit)
    topicText: { type: String, maxlength: 400 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LessonEmbedding", lessonEmbeddingSchema);
