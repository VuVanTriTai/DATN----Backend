// models/Chunk.js
const mongoose = require("mongoose");

/**
 * Mỗi Chunk = một đoạn văn bản semantic từ tài liệu gốc,
 * đã được embed thành vector để phục vụ Vector Search.
 *
 * Quan hệ: Plan (1) ──< Chunk (many)
 */
const chunkSchema = new mongoose.Schema(
  {
    // ── Foreign key ──────────────────────────────────────────────
    planId: {
      type    : mongoose.Schema.Types.ObjectId,
      ref     : "Plan",
      required: true,
      index   : true,
    },

    // ── Content ──────────────────────────────────────────────────
    content: {
      type    : String,
      required: true,
    },

    // Section heading chunk này thuộc về (e.g. "## 1.1 Hàm CAST")
    // Populated từ chunkText / aiChunkText → chunk.section
    // Dùng để filter theo coveredSections khi generate lesson
    section: {
      type   : String,
      default: "",
      index  : true,   // thêm index — thường xuyên filter theo section
    },

    // ── Topic (thêm bởi TopicClassifier) ─────────────────────────────
    // e.g. "date_function", "stored_procedure", "control_flow", "general"
    // Dùng để filter RAG retrieval theo loại nội dung,
    // tránh kéo stored procedure vào lesson về date function.
    topic: {
      type   : String,
      default: "general",
      index  : true,
    },

    // Thứ tự chunk trong tài liệu — cần để reconstruct context window
    // và hiển thị kết quả theo đúng thứ tự đọc
    chunkIndex: {
      type    : Number,
      required: true,
    },

    // ── Vector ───────────────────────────────────────────────────
    embedding: {
      type    : [Number],
      required: true,
      // NOTE: KHÔNG đặt index ở đây — Atlas Vector Search index
      // được tạo riêng qua Atlas UI / Data API với type "vectorSearch"
      // trên field này. Mongoose index thông thường không có tác dụng
      // với vector search.
    },

    // ── Metadata (mở rộng dần, không breaking) ───────────────────
    metadata: {
      wordCount      : { type: Number },
      embeddingModel : { type: String },   // e.g. "text-embedding-3-small"
                                           // cần biết khi re-embed sau upgrade
    },
  },
  {
    timestamps: true,
  }
);

// ── Compound index: query phổ biến nhất là "tất cả chunks của plan X,
//    sorted theo thứ tự" — index này cover cả filter lẫn sort ──────
chunkSchema.index({ planId: 1, chunkIndex: 1 });

// ── Index cho filter theo section trong 1 plan ───────────────────
chunkSchema.index({ planId: 1, section: 1 });

// ── Index cho filter theo topic trong 1 plan ────────────────────
chunkSchema.index({ planId: 1, topic: 1 });

module.exports = mongoose.model("Chunk", chunkSchema);