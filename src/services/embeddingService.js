// src/services/embeddingService.js
const { pipeline } = require('@xenova/transformers');

let extractor = null;

const getExtractor = async () => {
    if (!extractor) {
        console.log("--- Đang nạp Model Embedding 1024 chiều (Lần đầu sẽ mất 1-2 phút) ---");
        // Model này chuẩn 1024 dimensions, hỗ trợ đa ngôn ngữ cực mạnh
        extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-large');
    }
    return extractor;
};

const generateEmbedding = async (text) => {
    try {
        const pipe = await getExtractor();
        
        // Tạo embedding từ văn bản
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        
        // Chuyển kết quả về mảng số thực (Dài đúng 1024)
        const embedding = Array.from(output.data);
        
        return embedding; 
    } catch (error) {
        console.error("Local Embedding 1024 Error:", error.message);
        throw new Error("Lỗi tạo vector 1024 chiều nội bộ.");
    }
};

module.exports = { generateEmbedding };