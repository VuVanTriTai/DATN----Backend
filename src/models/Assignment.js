// models/Assignment.js
const mongoose = require("mongoose");
// Bản chất của Assignment: một bài tập mà learner đã submit,
//  instructor sẽ chấm điểm và feedback
// Mỗi Assignment liên kết với một Plan và một Lesson cụ thể,
//  để dễ dàng tracking tiến độ học tập của learner trên từng bài học trong kế hoạch.
const assignmentSchema = new mongoose.Schema({
  learnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Để instructor dễ query
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true },
  lessonId: { type: mongoose.Schema.Types.ObjectId, ref: "Lesson", required: true },
  
  fileUrl: String, // Link file bài tập đã upload
  learnerNote: String,
  
  // Instructor sẽ cập nhật 2 field này (hoặc AI tự động chấm)
  score: { type: Number, min: 0, max: 10 },
  feedback: String,
  gradedAt: Date,

  // ── AI GRADING ───────────────────────────────────────────────
  aiScore: { type: Number, min: 0, max: 10 },
  aiFeedback: String,
  // ────────────────────────────────────────────────────────────

  status: { type: String, enum: ["submitted", "graded", "ai_graded"], default: "submitted" }
}, { timestamps: true });

module.exports = mongoose.model("Assignment", assignmentSchema);