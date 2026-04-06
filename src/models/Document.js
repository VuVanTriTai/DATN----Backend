// models/Document.js
const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  title: String,
  content: String,
  fileUrl: String
}, { timestamps: true });

module.exports = mongoose.model("Document", documentSchema);