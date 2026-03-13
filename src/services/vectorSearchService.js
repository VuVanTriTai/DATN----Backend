const Chunk = require('../models/Chunk');
const { generateEmbedding } = require('./embeddingService');
const mongoose = require('mongoose');

const searchSimilarChunks = async (queryText, courseId) => {
    try {
        const queryVector = await generateEmbedding(queryText);

        // Đảm bảo courseId là kiểu ObjectId hợp lệ
        const oid = new mongoose.Types.ObjectId(courseId);

        const results = await Chunk.aggregate([
            {
                $vectorSearch: {
                    index: "vector_index", 
                    path: "embedding",
                    queryVector: queryVector,
                    numCandidates: 100,
                    limit: 5,
                    filter: { courseId: { $eq: oid } } // Lọc theo đúng khóa học/tài liệu
                }
            },
            {
                $project: {
                    _id: 0,
                    content: 1,
                    score: { $meta: "vectorSearchScore" }
                }
            }
        ]);

        return results;
    } catch (error) {
        console.error("Vector Search Error:", error.message);
        throw error;
    }
};

module.exports = { searchSimilarChunks };