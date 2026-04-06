const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
    title: { type: String, required: true },
    topic: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Learner tạo ra
    
    // NGƯỜI HƯỚNG DẪN được học viên chọn
    instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, 
    
    duration: { type: Number, default: 7 },
    level: { type: String, enum: ['Easy', 'Medium', 'Hard'], default: 'Medium' },
    /** Mục tiêu học khi tạo lộ trình từ tài liệu */
    learningGoals: {
        focus: { type: String, enum: ['theory', 'practice'], default: 'theory' },
        depth: { type: String, enum: ['basic', 'deep'], default: 'basic' }
    },
    description: String,
    
    // TÍNH NĂNG CHIA SẺ
    isPublic: { type: Boolean, default: false }, // Cho phép người khác xem
    
    isDeleted: { type: Boolean, default: false },
    // Thêm vào planSchema
documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);