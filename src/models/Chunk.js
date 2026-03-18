const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema({
    courseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Plan', // Giả sử Plan là Model khóa học của bạn
        required: true
    },
    chunkIndex: { type: Number, required: true },
    content: { type: String, required: true },
    embedding: {
        type: [Number], // Mảng các số thực đại diện cho Vector
        // // Mảng 1536 số thực cho model text-embedding-3-small
        required: true
    },
    wordCount: { type: Number },
    createdAt: { type: Date, default: Date.now }
});

// Đánh dấu index cho courseId để truy vấn nhanh hơn
chunkSchema.index({ courseId: 1 });

module.exports = mongoose.model('Chunk', chunkSchema);