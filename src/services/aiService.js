const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks } = require("./vectorSearchService");
const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const chatWithDocument = async (question, planId) => {
    // 1. Embedding câu hỏi
    const queryVector = await generateEmbedding(question);

    // 2. Retrieval: Tìm Top-K đoạn văn liên quan (Theo tài liệu đề xuất)
    const context = await searchRelevantChunks(planId, queryVector, 5);

    // 3. Generation: Trả lời dựa trên ngữ cảnh
    const prompt = `Bạn là trợ lý học tập thông minh. 
    Dựa vào ngữ cảnh dưới đây để trả lời câu hỏi của người dùng. 
    Nếu thông tin không có trong ngữ cảnh, hãy nói "Tôi không tìm thấy thông tin này trong tài liệu".
    
    NGỮ CẢNH: ${context}
    CÂU HỎI: ${question}`;

    const response = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.1-8b-instant",
    });

    return response.choices[0].message.content;
};

module.exports = { chatWithDocument };