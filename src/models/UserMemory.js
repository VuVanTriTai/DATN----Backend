// models/UserMemory.js
const mongoose = require("mongoose");

const userMemorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    topic: { type: String, required: true },
    count: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model("UserMemory", userMemorySchema);