const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema({
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    dayNumber: { type: Number, required: true },
    title: String,
    content: { type: String, required: true }, // Nội dung văn bản chi tiết
    summary: String, // Tóm tắt bài học
    quiz: [{
        question: String,
        options: [String],
        correctAnswer: Number,
        explanation: String
    }],
    status: { type: String, enum: ['locked', 'in-progress', 'completed'], default: 'locked' }
});

module.exports = mongoose.model('Lesson', lessonSchema);