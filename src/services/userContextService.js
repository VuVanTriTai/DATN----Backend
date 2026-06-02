// services/personalizationService.js
// Dịch vụ này sẽ xử lý các logic liên quan đến cá nhân hóa trải nghiệm học tập của người dùng, như cập nhật bộ nhớ học tập và xác định chế độ học tập phù hợp dựa trên tiến trình của họ.
const UserMemory = require("../models/UserMemory");

/**
 * 📌 UPDATE MEMORY (đã có nhưng viết lại chuẩn hơn)
 */
const updateUserMemory = async (userId, topic) => {
    try {
        if (!userId || !topic) return;

        const existing = await UserMemory.findOne({ userId, topic });

        if (existing) {
            existing.count += 1;
            await existing.save();
        } else {
            await UserMemory.create({
                userId,
                topic,
                count: 1
            });
        }

    } catch (err) {
        console.error("❌ updateUserMemory error:", err.message);
    }
};


/**
 * 📌 GET LEARNING MODE (QUAN TRỌNG)
 */
const getLearningMode = async (userId, currentTopic) => {
    try {
        // Tìm toàn bộ lịch sử học tập của user này (không chỉ trong plan hiện tại)
        const progress = await Progress.findOne({ userId, "knowledgeMap.topic": currentTopic });
        
        if (!progress) return "NORMAL";

        // Lấy thông tin tri thức về topic cụ thể này
        const topicInfo = progress.knowledgeMap.find(k => k.topic === currentTopic);
        
        if (topicInfo.score >= 80) return "ADVANCED";
        if (topicInfo.score < 50) return "REMEDIAL";

        return "NORMAL";
    } catch (err) {
        return "NORMAL";
    }
};

module.exports = {
    updateUserMemory,
    getLearningMode
};