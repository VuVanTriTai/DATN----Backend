const Chunk = require("../models/Chunk");
const { generateEmbedding } = require("./embeddingService");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const saveChunksWithEmbeddings = async (planId, chunks) => {
  try {
    const preparedDocs = [];

    for (const chunk of chunks) {
      if (!chunk.content || chunk.content.length < 20) continue;

      console.log(`📦 Embedding chunk ${chunk.index}...`);
      
      // Tạo vector 1024-dim
      const vector = await generateEmbedding(chunk.content, "passage");

      preparedDocs.push({
        planId,
        chunkIndex: chunk.index,
        content: chunk.content,
        embedding: vector,
        metadata: { wordCount: chunk.wordCount }
      });

      // Tránh nghẽn CPU nếu chạy Local model
      await sleep(50); 
    }

    if (preparedDocs.length > 0) {
      await Chunk.insertMany(preparedDocs);
      console.log(`✅ Đã lưu ${preparedDocs.length} chunks vào DB.`);
    }
  } catch (error) {
    console.error("❌ Vector Store Error:", error.message);
    throw error;
  }
};

module.exports = { saveChunksWithEmbeddings };