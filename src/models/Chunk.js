// models/Chunk.js
const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema({
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Plan",
    required: true,
    index: true
  },
  content: {
    type: String,
    required: true
  },
  embedding: {
    type: [Number],
    required: true
  },
  chunkIndex: Number,

  // ✅ NÊN GIỮ
  metadata: {
    wordCount: Number
  }

}, { timestamps: true });

// Lưu ý: Bạn cần tạo Search Index trên MongoDB Atlas cho field 'embedding'
module.exports = mongoose.model('Chunk', chunkSchema);