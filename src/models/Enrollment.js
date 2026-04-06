const mongoose = require("mongoose");

const enrollmentSchema = new mongoose.Schema({
  learnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true },

  status: {
    type: String,
    enum: ["pending", "active", "completed", "rejected"],
    default: "pending"
  }
}, { timestamps: true });

// Index để đảm bảo 1 học viên không đăng ký 1 lộ trình cho 1 giáo viên 2 lần
enrollmentSchema.index({ learnerId: 1, planId: 1, instructorId: 1 }, { unique: true });

module.exports = mongoose.model("Enrollment", enrollmentSchema);