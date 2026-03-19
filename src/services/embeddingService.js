// src/services/embeddingService.js
const { pipeline } = require('@xenova/transformers');

let extractor = null;

const getExtractor = async () => {
    if (!extractor) {
        // Sử dụng model 'all-MiniLM-L6-v2' - cực nhẹ, chạy nhanh trên CPU
        // Model này trả về vector 384 chiều
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return extractor;
};

const generateEmbedding = async (text) => {
    try {
        const pipe = await getExtractor();
        
        // Tạo embedding
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        
        // Chuyển kết quả về dạng mảng số (Array of numbers)
        const embedding = Array.from(output.data);
        
        return embedding; 
    } catch (error) {
        console.error("Local Embedding Error:", error.message);
        throw new Error("Lỗi khi tạo embedding nội bộ: " + error.message);
    }
};

module.exports = { generateEmbedding };