const mongoose = require('mongoose');

const attemptSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        quiz: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Quiz',
            required: true,
        },
        quizTitle: { type: String, required: true }, 
        attemptNumber: { type: Number, required: true }, // attempt thứ mấy của quiz này
        duration: { type: Number, required: true }, // tính bằng giây
        answers: { type: mongoose.Schema.Types.Mixed, required: true }, // lưu trữ câu trả lời của người dùng
        score: { type: Number, required: true },
        totalQuestions: { type: Number, required: true },
        isDeleted: { type: Boolean, default: false },
        deleteAt: { type: Date, default: null },
    },
    { timestamps: true },
);

module.exports = mongoose.model('Attempt', attemptSchema);