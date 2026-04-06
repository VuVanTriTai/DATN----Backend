const { searchRelevantChunks } = require('./vectorSearchService');
const { generateEmbedding } = require('./embeddingService');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const answerQuestionWithRAG = async (question, planId) => {
    try {
        // 1. Tìm context bằng type="query"
        const queryVector = await generateEmbedding(question, "query");
        const relevantChunks = await searchRelevantChunks(planId, queryVector, 5);

        const contextText = relevantChunks.map(c => c.content).join("\n\n");

        const prompt = `Bạn là trợ lý học tập. Hãy trả lời câu hỏi dựa TRÊN DUY NHẤT ngữ cảnh tài liệu được cung cấp.
        Nếu không có thông tin trong tài liệu, hãy nói 'Tôi không tìm thấy nội dung này'.
        
        NGỮ CẢNH: ${contextText}
        CÂU HỎI: ${question}`;

        const res = await groq.chat.completions.create({
            messages: [{ role: "system", content: "Bạn là robot trích xuất thông tin." }, { role: "user", content: prompt }],
            model: "llama-3.1-8b-instant",
            temperature: 0
        });

        return {
            answer: res.choices[0].message.content,
            sources: relevantChunks.map(c => c.content.substring(0, 100) + "...")
        };
    } catch (error) {
        return { answer: "Lỗi xử lý câu hỏi.", sources: [] };
    }
};

module.exports = { answerQuestionWithRAG };