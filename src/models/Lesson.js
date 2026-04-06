// models/Lesson.js
const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema({
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    dayNumber: { type: Number, required: true },
    title: String,
    content: { type: String, required: true },
    summary: String,
    importantNotes: [String],

    quiz: [/* giữ nguyên */],

    status: { type: String, enum: ['locked', 'in-progress', 'completed'], default: 'locked' },

    // 🔥 thêm
    isDeleted: { type: Boolean, default: false },
    deleteAt: { type: Date, default: null },

});
module.exports = mongoose.model('Lesson', lessonSchema);