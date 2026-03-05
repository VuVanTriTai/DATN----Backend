const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
    title: { type: String, required: true },
    topic: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    duration: { type: Number, default: 7 }, // Số ngày học
    level: { type: String, default: 'Cơ bản' },
    description: String,
    isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);