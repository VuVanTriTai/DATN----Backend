const Chunk = require('../models/Chunk');

const searchRelevantChunks = async (planId, queryEmbedding, limit = 5) => {
    const results = await Chunk.aggregate([
      {
        "$vectorSearch": {
          "index": "vector_index",
          "path": "embedding",
          "queryVector": queryEmbedding,
          "numCandidates": 100,
          "limit": limit,
          "filter": { "planId": planId } // Lọc chính xác tài liệu của khóa học này
        }
      }
    ]);
    
    // Nếu kết quả rỗng, trả về thông báo để LLM không bịa nội dung
    if (results.length === 0) return "Không tìm thấy dữ liệu liên quan.";
    
    return results.map(r => r.content).join("\n\n");
};
const reRank = async (query, documents) => {
    // Gọi mô hình Cross-Encoder (ms-marco-MiniLM-L6-v2 như trong báo cáo)
    const response = await axios.post(
        "https://api-inference.huggingface.co/models/cross-encoder/ms-marco-MiniLM-L6-v2",
        { 
            inputs: documents.map(doc => ({ source_sentence: query, sentences: [doc] })) 
        },
        { headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` } }
    );
    // Trả về văn bản đã được sắp xếp lại theo điểm số cao nhất
    return response.data; 
};

const searchWithReRank = async (planId, query, queryEmbedding) => {
    // 1. Lấy Top 10 từ Vector DB (Retrieval)
    const topK = await searchFromVectorDB(planId, queryEmbedding, 10);
    
    // 2. Re-ranking (Xếp hạng lại như Hình 2 bước 7)
    const rankedDocs = await reRank(query, topK);
    
    // 3. Lấy Top 3 cuối cùng (Hình 2 bước 8)
    return rankedDocs.slice(0, 3).join("\n\n");
};

module.exports = { searchRelevantChunks, searchWithReRank };