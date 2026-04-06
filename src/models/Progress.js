// THÊM DÒNG NÀY VÀO ĐẦU FILE
const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" },
  
  // Lưu chi tiết từng mảng kiến thức
  knowledgeMap: [
    {
      topic: String,      
      score: Number,      
      status: { 
        type: String, 
        enum: ["BEGINNER", "INTERMEDIATE", "EXPERT"],
        default: "INTERMEDIATE" 
      }
    }
  ],
  
  averageScore: { type: Number, default: 0 },
  totalQuizzesDone: { type: Number, default: 0 },
  currentLevel: { 
    type: String, 
    enum: ["BEGINNER", "INTERMEDIATE", "EXPERT"], 
    default: "INTERMEDIATE" 
  },
  completedDays: [Number]
}, { timestamps: true });

// ĐẢM BẢO CÓ DÒNG EXPORT NÀY
module.exports = mongoose.model("Progress", progressSchema);