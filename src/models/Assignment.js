const mongoose = require("mongoose");

const assignmentSchema = new mongoose.Schema({
  learnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Để instructor dễ query
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true },
  lessonId: { type: mongoose.Schema.Types.ObjectId, ref: "Lesson", required: true },
  
  fileUrl: String, // Link file bài tập đã upload
  learnerNote: String,
  
  // Instructor sẽ cập nhật 2 field này
  score: { type: Number, min: 0, max: 10 },
  feedback: String,
  gradedAt: Date,

  status: { type: String, enum: ["submitted", "graded"], default: "submitted" }
}, { timestamps: true });

module.exports = mongoose.model("Assignment", assignmentSchema);