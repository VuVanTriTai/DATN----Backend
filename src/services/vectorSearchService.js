const Chunk = require('../models/Chunk');

const searchRelevantChunks = async (planId, queryEmbedding, limit = 5) => {
    // Sử dụng MongoDB Atlas Vector Search
    const results = await Chunk.aggregate([
        {
            "$vectorSearch": {
                "index": "vector_index", // Tên index bạn tạo trên Atlas
                "path": "embedding",
                "queryVector": queryEmbedding,
                "numCandidates": 100,
                "limit": limit,
                "filter": { "planId": planId } // Chỉ tìm trong tài liệu của khóa học này
            }
        },
        {
            "$project": {
                "content": 1,
                "score": { "$meta": "vectorSearchScore" }
            }
        }
    ]);
    return results.map(r => r.content).join("\n\n");
};

module.exports = { searchRelevantChunks };