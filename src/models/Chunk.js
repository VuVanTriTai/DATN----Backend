const mongoose = require("mongoose");

/**
 * Mỗi Chunk = một đoạn văn bản semantic từ tài liệu gốc,
 * đã được embed thành vector để phục vụ Vector Search.
 *
 * Quan hệ: Plan (1) ──< Chunk (many)
 *
 * FIX: Thêm field `topicClassified` để backfill không re-classify
 *      những chunk đã được classify đúng (kể cả topic = "general").
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
    section: {
      type   : String,
      default: "",
      index  : true,
    },

    // ── Topic (thêm bởi TopicClassifier) ─────────────────────────
    // e.g. "date_function", "stored_procedure", "control_flow", "general"
    topic: {
      type   : String,
      default: "general",
      index  : true,
    },

    /**
     * FIX #4: Flag đánh dấu chunk đã được classify topic.
     * Dùng để backfill không re-classify chunk đã xử lý,
     * kể cả khi topic = "general" (đó có thể là kết quả đúng).
     * Trước khi có flag này, backfill sẽ re-classify mọi chunk
     * có topic = "general", gây tốn CPU và có thể ghi đè kết quả đúng.
     */
    topicClassified: {
      type   : Boolean,
      default: false,
      index  : true,
    },

    // Thứ tự chunk trong tài liệu
    chunkIndex: {
      type    : Number,
      required: true,
    },

    // ── Parent-Child RAG fields ──────────────────────────────────
    isChild: {
      type   : Boolean,
      default: false,
      index  : true,
    },

    parentId: {
      type   : mongoose.Schema.Types.ObjectId,
      ref    : "Chunk",
      default: null,
      index  : true,
    },

    // ── Vector ───────────────────────────────────────────────────
    embedding: {
      type    : [Number],
      required: true,
      // NOTE: Atlas Vector Search index được tạo riêng qua Atlas UI.
      // Mongoose index thông thường không có tác dụng với vector search.
    },

    // ── Metadata ─────────────────────────────────────────────────
    metadata: {
      wordCount      : { type: Number },
      embeddingModel : { type: String },
    },
  },
  {
    timestamps: true,
  }
);

// ── Compound indexes ──────────────────────────────────────────────
chunkSchema.index({ planId: 1, chunkIndex: 1 });
chunkSchema.index({ planId: 1, section: 1 });
chunkSchema.index({ planId: 1, topic: 1 });

module.exports = mongoose.model("Chunk", chunkSchema);