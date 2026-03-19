require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function listAllModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(apiKey);

    try {
        // Đây là hàm liệt kê tất cả model mà Key này có quyền dùng
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();

        console.log("--- DANH SÁCH CÁC MODEL KEY CỦA BẠN CÓ QUYỀN DÙNG ---");
        
        if (data.models) {
            const embeddingModels = data.models.filter(m => m.supportedGenerationMethods.includes("embedContent"));
            
            if (embeddingModels.length === 0) {
                console.log("❌ CẢNH BÁO: Key này KHÔNG CÓ QUYỀN dùng bất kỳ model Embedding nào!");
            } else {
                embeddingModels.forEach(m => {
                    console.log(`- Model Name: ${m.name}`); // Nó sẽ có dạng "models/text-embedding-004"
                });
                console.log("\n👉 Hãy copy chính xác dòng 'models/...' vào file embeddingService.js");
            }
        } else {
            console.log("Không tìm thấy model nào. Hãy kiểm tra lại API Key.");
        }
    } catch (error) {
        console.error("Lỗi khi lấy danh sách model:", error.message);
    }
}

listAllModels();