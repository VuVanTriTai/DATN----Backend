const mongoose = require("mongoose");

const instructorRatingSchema = new mongoose.Schema({
  instructor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  learner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  stars: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: "" },
}, { timestamps: true });

// Mỗi học viên chỉ đánh giá 1 lần mỗi giáo viên
instructorRatingSchema.index({ instructor: 1, learner: 1 }, { unique: true });

module.exports = mongoose.model("InstructorRating", instructorRatingSchema);
