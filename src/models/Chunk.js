const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema({
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', index: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    chunkIndex: Number,
    metadata: {
        wordCount: Number // Lưu lại số từ để sau này debug hoặc tính token
    }
});

// Lưu ý: Bạn cần tạo Search Index trên MongoDB Atlas cho field 'embedding'
module.exports = mongoose.model('Chunk', chunkSchema);