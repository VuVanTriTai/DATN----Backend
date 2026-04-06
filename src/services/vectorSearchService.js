const mongoose = require("mongoose");
const Chunk = require("../models/Chunk");
const axios = require("axios");

/**
 * 🔍 VECTOR SEARCH CHÍNH XÁC
 */
const searchRelevantChunks = async (planId, queryEmbedding, limit = 5) => {
  try {
    const oid = new mongoose.Types.ObjectId(planId);

    // 1. Kiểm tra dữ liệu thực tế
    const count = await Chunk.countDocuments({ planId: oid });
    console.log(`📊 Kiểm tra DB: Plan ${planId} có ${count} chunks.`);

    // 2. Thực hiện Vector Search
    let results = await Chunk.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit: limit * 2, // Lấy dư ra để lọc trùng
          filter: { planId: oid },
        },
      },
      {
        $project: {
          content: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ]);

    // 3. Xử lý sau khi có kết quả (Tránh lỗi Initialization)
    if (!results || results.length === 0) {
      console.warn("⚠️ Vector search rỗng → fallback lấy chunk đầu tiên");
      results = await Chunk.find({ planId: oid }).limit(limit).lean();
    }

    // Lọc trùng nội dung (Dùng Set)
    const seen = new Set();
    const uniqueResults = [];
    for (const r of results) {
      if (!seen.has(r.content)) {
        seen.add(r.content);
        uniqueResults.push(r);
      }
    }

    // Cắt ngắn và format kết quả
    const cleaned = uniqueResults.slice(0, limit).map((r) => ({
      content: r.content.substring(0, 1000), 
      score: r.score || 0.5,
    }));

    console.log(`✅ Tìm thấy ${cleaned.length} đoạn văn bản liên quan.`);
    return cleaned;
  } catch (error) {
    console.error("❌ Vector Search Error:", error.message);
    return [];
  }
};

/**
 * 🚀 RE-RANKER (Sử dụng Cross-Encoder theo tài liệu của bạn)
 */
const reRank = async (query, documents) => {
  try {
    if (!documents?.length || !process.env.HF_TOKEN) return documents;

    const response = await axios.post(
      "https://router.huggingface.co/models/cross-encoder/ms-marco-MiniLM-L6-v2",
      {
        inputs: documents.map((doc) => ({
          source_sentence: query,
          sentences: [doc.content],
        })),
      },
      {
        headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` },
        timeout: 10000,
      }
    );

    const scores = response.data;
    const ranked = documents.map((doc, i) => ({
      ...doc,
      reRankScore: scores[i] ?? 0,
    }));

    return ranked.sort((a, b) => b.reRankScore - a.reRankScore);
  } catch (err) {
    console.error("⚠️ Re-rank fail, dùng kết quả gốc:", err.message);
    return documents;
  }
};

module.exports = { searchRelevantChunks, reRank };