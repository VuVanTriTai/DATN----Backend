const { searchSimilarChunks } = require('./vectorSearchService');
const Groq = require('groq-sdk');

// Khởi tạo Groq Client
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

const answerQuestionWithRAG = async (question, courseId) => {
    try {
        // 1. Tìm ngữ cảnh liên quan từ MongoDB Vector Search
        const relevantChunks = await searchSimilarChunks(question, courseId);

        if (!relevantChunks || relevantChunks.length === 0) {
            return {
                answer: "Xin lỗi, tôi không tìm thấy thông tin liên quan trong tài liệu bạn đã tải lên để trả lời câu hỏi này.",
                sources: []
            };
        }

        // 2. Chuẩn bị ngữ cảnh cho Groq
        const contextText = relevantChunks.map(chunk => chunk.content).join("\n\n---\n\n");

        // 3. Gọi Groq với model Llama 3 (Cực nhanh và thông minh)
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: `Bạn là một trợ lý học tập AI chuyên nghiệp. 
                    Nhiệm vụ của bạn là trả lời câu hỏi của học sinh dựa TRỰC TIẾP vào nội dung tài liệu được cung cấp dưới đây.
                    Nếu thông tin không có trong tài liệu, hãy lịch sự từ chối thay vì tự bịa ra câu trả lời.
                    Hãy trả lời bằng Tiếng Việt, trình bày rõ ràng, dễ hiểu.`
                },
                {
                    role: "user",
                    content: `NỘI DUNG TÀI LIỆU:
                    ${contextText}
                    
                    CÂU HỎI CỦA HỌC SINH: 
                    ${question}`
                }
            ],
            model: "llama-3.3-70b-versatile", // Model mạnh nhất hiện tại của Groq
            temperature: 0.2, // Thấp để đảm bảo tính chính xác theo tài liệu
            max_tokens: 1024,
        });

        return {
            answer: chatCompletion.choices[0].message.content,
            sources: relevantChunks.map(c => ({ 
                content: c.content.substring(0, 150) + "...", 
                score: c.score 
            }))
        };

    } catch (error) {
        console.error("Groq RAG Service Error:", error.message);
        throw new Error("Lỗi khi AI xử lý câu trả lời.");
    }
};

module.exports = { answerQuestionWithRAG };