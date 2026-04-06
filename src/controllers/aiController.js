const ragService = require('../services/ragService');
const { searchRelevantChunks } = require('../services/vectorSearchService');
const { generateEmbedding } = require('../services/embeddingService');

/**
 * Tìm kiếm đoạn văn bản liên quan (Dùng cho tab Tài liệu)
 */
const searchRelevantContent = async (req, res) => {
    try {
        const { question, planId } = req.body;
        if (!question || !planId) return res.error("Thiếu thông tin truy vấn", 400);

        // Tạo vector cho câu hỏi và tìm trong DB
        const queryVector = await generateEmbedding(question, "query");
        const relevantChunks = await searchRelevantChunks(planId, queryVector, 5);

        return res.success(relevantChunks);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * Chat thông minh (RAG)
 */
const chatWithDocument = async (req, res) => {
    try {
        const { question, planId } = req.body;
        if (!question || !planId) return res.error("Vui lòng cung cấp câu hỏi và ID lộ trình", 400);

        const result = await ragService.answerQuestionWithRAG(question, planId);
        return res.success(result);
    } catch (error) {
        console.error("AI Chat Error:", error.message);
        return res.error("AI hiện không thể trả lời, vui lòng thử lại sau.", 500);
    }
};

// QUAN TRỌNG: Phải export đúng tên để Route nhận diện được
module.exports = { 
    searchRelevantContent, 
    chatWithDocument 
};