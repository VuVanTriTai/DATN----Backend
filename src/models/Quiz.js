const mongoose = require("mongoose");

const Question = new mongoose.Schema(
  {
    questionType: {
      type: String,
      enum: ["multipleStatements", "singleChoice", "multipleChoice"],
      required: true,
    },
    text: { type: String, required: true },
    options: [{ type: String, required: true }],
    correctAnswer: { type: mongoose.Schema.Types.Mixed, required: true },
    explanation: { type: String, required: true },
  },
  { _id: false },
);

const quizSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    topic: { type: String, required: true },
    numQuestions: { type: Number, required: true },
    difficulty: { type: String, required: true },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    questionType: {
      type: String,
      enum: ["multipleStatements", "singleChoice", "multipleChoice", "mixed"],
      default: "singleChoice",
    },
    timeLimit: { type: Number, required: false }, // tính theo phút
    maxAttempts: { type: Number, required: false },
    questions: { type: [Question] },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Quiz", quizSchema);
