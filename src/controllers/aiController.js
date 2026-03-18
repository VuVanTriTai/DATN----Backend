// Import cả 2 service: 1 cái để search, 1 cái để RAG (trả lời)
const { searchSimilarChunks } = require('../services/vectorSearchService');
const { answerQuestionWithRAG } = require('../services/ragService');

/**
 * API: Tìm kiếm các đoạn văn bản liên quan (Dùng cho tab Tài liệu)
 * POST /api/ai/search
 */
const searchRelevantContent = async (req, res) => {
    try {
        const { question, courseId } = req.body;
        if (!question || !courseId) return res.error("Thiếu câu hỏi hoặc ID khóa học", 400);

        const relevantChunks = await searchSimilarChunks(question, courseId);
        
        return res.success({
            question,
            relevantChunks
        }, "Đã tìm thấy các dữ liệu liên quan.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * API: Chat thông minh dựa trên tài liệu (Dùng cho tab Phòng chat - RAG)
 * POST /api/ai/chat-doc
 */
const chatWithDocument = async (req, res) => {
    try {
        const { question, courseId } = req.body;
        if (!question || !courseId) return res.error("Vui lòng cung cấp câu hỏi và ID khóa học", 400);

        // Đây là hàm gọi sang ragService mà tôi đã viết ở tin nhắn trước
        const result = await answerQuestionWithRAG(question, courseId);

        return res.success(result, "AI đã phản hồi thành công.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

// Xuất cả 2 hàm để Route sử dụng
module.exports = { 
    searchRelevantContent, 
    chatWithDocument 
};