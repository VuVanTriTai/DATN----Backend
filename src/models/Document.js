// models/Document.js
const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  title: String,
  content: String,
  // PHẢI CÓ DÒNG NÀY THÌ MỚI LƯU ĐƯỢC LINK CLOUDINARY
  fileUrl: { type: String, required: false }, 
  // THÊM TRƯỜNG NÀY:
  contentHash: { type: String, index: true },
  metadata: { type: Object, default: {} } 
}, { timestamps: true });

module.exports = mongoose.model("Document", documentSchema);