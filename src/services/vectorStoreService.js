const Chunk = require('../models/Chunk');
const { generateEmbedding } = require('./embeddingService');

const saveChunksWithEmbeddings = async (courseId, chunks) => {
    try {
        const preparedChunks = await Promise.all(
            chunks.map(async (chunk) => {
                const vector = await generateEmbedding(chunk.content);
                return {
                    courseId: courseId,
                    chunkIndex: chunk.index,
                    content: chunk.content,
                    embedding: vector,
                    wordCount: chunk.wordCount
                };
            })
        );

        return await Chunk.insertMany(preparedChunks);
    } catch (error) {
        throw new Error(`Lỗi lưu vào Vector Store: ${error.message}`);
    }
};

module.exports = { saveChunksWithEmbeddings };