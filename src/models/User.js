const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  role: { 
    type: String, 
    enum: ["learner", "instructor"], 
    default: "learner" 
  },
  // Dành riêng cho Instructor để Learner chọn
  instructorProfile: {
    specialization: String,
    bio: String,
    rating: { type: Number, default: 5 }
  },
  learningPreferences: {
    level: { type: String, default: "NORMAL" },
    interests: [{ type: String }]
  },
  refreshToken: String
}, { timestamps: true });

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

module.exports = mongoose.model("User", userSchema);