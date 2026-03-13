const { GoogleGenerativeAI } = require("@google/generative-ai");

const generateEmbedding = async (text) => {
    try {
        // Nhắc nhở: Groq không có Embedding, nên vẫn phải dùng Gemini ở đây
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("Thiếu GEMINI_API_KEY để tạo Vector.");
        }

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

        const cleanText = text.replace(/\n/g, " ");
        const result = await model.embedContent(cleanText);
        
        return result.embedding.values; 
    } catch (error) {
        console.error("Embedding Error:", error.message);
        throw new Error("Lỗi tạo vector: " + error.message);
    }
};

module.exports = { generateEmbedding };