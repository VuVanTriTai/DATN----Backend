// services/vectorSearchService.js
"use strict";

const mongoose = require("mongoose");
const Chunk = require("../models/Chunk");
const axios = require("axios");


// ─────────────────────────────────────────────
// VECTOR SEARCH (SAFE VERSION)
// ─────────────────────────────────────────────

const searchRelevantChunks = async (planId, queryEmbedding, limit = 5) => {
  try {
    const oid = new mongoose.Types.ObjectId(planId);

    console.log(`🔍 Vector search plan=${planId}`);

    // ❗ FIX 1: Guard embedding
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      console.warn("⚠️ queryEmbedding invalid → fallback DB");
      return fallbackRandomChunks(oid, limit);
    }

    let results = [];

    try {
      results = await Chunk.aggregate([
        {
          $vectorSearch: {
            index: "vector_index",
            path: "embedding",
            queryVector: queryEmbedding,
            numCandidates: 50, // 🔥 giảm load
            limit: limit * 2,
            filter: { planId: oid },
          },
        },
        {
          $project: {
            content: 1,
            section: 1,
            topic: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
      ]);
    } catch (err) {
      console.warn("⚠️ Vector search failed:", err.message);
    }

    // ❗ FIX 2: fallback nếu fail hoặc rỗng
    if (!results?.length) {
      return fallbackRandomChunks(oid, limit);
    }

    return postProcess(results, limit);

  } catch (error) {
    console.error("❌ searchRelevantChunks error:", error.message);
    return [];
  }
};

// ─────────────────────────────────────────────
// TOPIC-FILTERED VECTOR SEARCH
// ─────────────────────────────────────────────

/**
 * Vector search có topic filter.
 * Chỉ trả về chunks thuộc các topic cho phép.
 * Nếu allowedTopics rỗng → fallback sang searchRelevantChunks (không filter).
 *
 * @param {string} planId
 * @param {number[]} queryEmbedding
 * @param {string[]} allowedTopics - ví dụ: ["date_function", "string_function"]
 * @param {number} [limit=5]
 */
const searchRelevantChunksByTopic = async (
  planId, queryEmbedding, allowedTopics = [], limit = 5
) => {
  // No topic filter → regular search
  if (!allowedTopics.length) {
    return searchRelevantChunks(planId, queryEmbedding, limit);
  }

  try {
    const oid = new mongoose.Types.ObjectId(planId);

    console.log(`🔍 Topic-filtered search plan=${planId} topics=${allowedTopics.join(",")}`);

    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      console.warn("⚠️ queryEmbedding invalid → fallback topic DB");
      return fallbackTopicChunks(oid, allowedTopics, limit);
    }

    let results = [];

    try {
      // Atlas Vector Search có hỗ trợ pre-filter theo field
      // NOTE: filter trong $vectorSearch chỉ dùng được khi field đó
      // được index trong Atlas Vector Index dưới dạng "filter".
      // Nếu chưa có, dùng $match sau $vectorSearch.
      results = await Chunk.aggregate([
        {
          $vectorSearch: {
            index: "vector_index",
            path: "embedding",
            queryVector: queryEmbedding,
            numCandidates: Math.max(100, limit * 10),  // lấy nhiều để filter sau
            limit: limit * 6,                           // rộng để sau $match có đủ
            filter: { planId: oid },
          },
        },
        // Post-filter theo topic (hoạt động dù Atlas filter field hay không)
        {
          $match: {
            topic: { $in: allowedTopics }
          },
        },
        {
          $project: {
            content: 1,
            section: 1,
            topic: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
        { $limit: limit * 2 },
      ]);
    } catch (err) {
      console.warn("⚠️ Topic vector search failed:", err.message);
    }

    if (!results?.length) {
      console.warn("⚠️ Topic filter → fallback DB");
      return fallbackTopicChunks(oid, allowedTopics, limit);
    }

    return postProcess(results, limit);

  } catch (error) {
    console.error("❌ searchRelevantChunksByTopic error:", error.message);
    // Last-resort fallback: không filter topic
    return searchRelevantChunks(planId, queryEmbedding, limit);
  }
};

// ─────────────────────────────────────────────
// FALLBACK
// ─────────────────────────────────────────────

const fallbackRandomChunks = async (oid, limit) => {
  const docs = await Chunk.find({ planId: oid })
    .select("content section topic")
    .limit(limit * 2)
    .lean();

  console.warn(`⚠️ Fallback DB → ${docs.length} chunks`);

  return postProcess(docs, limit);
};

// Fallback: filter theo topic thôi, không có vector
const fallbackTopicChunks = async (oid, allowedTopics, limit) => {
  const docs = await Chunk.find({
    planId: oid,
    topic: { $in: allowedTopics }
  })
    .select("content section topic")
    .limit(limit * 2)
    .lean();

  console.warn(`⚠️ Topic Fallback DB → ${docs.length} chunks`);

  // Nếu cạn không có chunk nào khớp topic → bỏ filter, lấy tất cả
  if (!docs.length) {
    return fallbackRandomChunks(oid, limit);
  }

  return postProcess(docs, limit);
};

// ─────────────────────────────────────────────
// POST PROCESS (dedupe + trim)
// ─────────────────────────────────────────────

const postProcess = (results, limit) => {
  const seen = new Set();
  const unique = [];

  for (const r of results) {
    if (!r?.content || seen.has(r.content)) continue;
    seen.add(r.content);
    unique.push(r);
  }

  // ✅ FIX: giữ lại chunkIndex để caller có thể sort theo thứ tự gốc tài liệu
  const final = unique.slice(0, limit).map(r => ({
    content: r.content.substring(0, 2000), // 2000 chars × 6 chunks = 12000 ≤ MAX_CONTEXT_CHARS
    section: r.section || "",
    topic: r.topic || "general",
    score: r.score || 0.5,
    chunkIndex: r.chunkIndex ?? r.index ?? null,  // thứ tự gốc trong tài liệu
  }));

  console.log(`✅ Retrieved ${final.length} chunks`);
  return final;
};

// ─────────────────────────────────────────────
// COSINE SIM (SAFE)
// ─────────────────────────────────────────────

const cosineSim = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0, na = 0, nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
};

// ─────────────────────────────────────────────
// SECTION SEARCH (SAFE)
// ─────────────────────────────────────────────

const escapeRegex = (s) =>
  String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bỏ markdown ATX đầu dòng + gom khoảng trắng — khớp với chunk.section thường không có # */
const normalizeSectionQuery = (s) => {
  let t = String(s || "").trim();
  t = t.replace(/^#{1,6}\s+/, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

/**
 * Từ mỗi coveredSection tạo 1–2 mẫu regex ngắn (dedupe) để khớp Chunk.section.
 */
const buildSectionSearchPatterns = (coveredSections) => {
  const or = [];
  const seen = new Set();

  const pushPattern = (fragment) => {
    const f = String(fragment || "").trim();
    if (f.length < 2) return;
    const rx = escapeRegex(f).substring(0, 40);
    if (rx.length < 2) return;
    const key = rx.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    or.push({ section: { $regex: rx, $options: "i" } });
  };

  for (const raw of coveredSections) {
    const norm = normalizeSectionQuery(raw);
    if (!norm) continue;

    pushPattern(norm.substring(0, 40));

    const m = norm.match(/^(\d+(?:\.\d+)+)\s+(.+)/);
    if (m) {
      const words = m[2].trim().split(/\s+/).slice(0, 4).join(" ");
      if (words.length >= 2) {
        const alt = `${m[1]} ${words}`.trim().substring(0, 40);
        if (alt !== norm.substring(0, Math.min(40, norm.length))) {
          pushPattern(alt);
        }
      }
    }
  }

  return or;
};

const searchChunksBySection = async (planId, coveredSections, queryEmbedding, limit = 6) => {
  try {
    const oid = new mongoose.Types.ObjectId(planId);

    // ❗ FIX: embedding invalid → fallback luôn
    if (!Array.isArray(queryEmbedding)) {
      return searchRelevantChunks(planId, queryEmbedding, limit);
    }

    if (!coveredSections?.length) {
      return searchRelevantChunks(planId, queryEmbedding, limit);
    }

    const patterns = buildSectionSearchPatterns(coveredSections);
    if (!patterns.length) {
      return searchRelevantChunks(planId, queryEmbedding, limit);
    }

    const chunks = await Chunk.find({
      planId: oid,
      $or: patterns
    }).select("content section topic chunkIndex embedding").lean();

    console.log(`📂 Section search → ${chunks.length} chunks`);

    if (!chunks.length) {
      return searchRelevantChunks(planId, queryEmbedding, limit);
    }

    const scored = chunks
      .filter(c => Array.isArray(c.embedding))
      .map(c => ({
        content: c.content.substring(0, 2000),
        section: c.section || "",
        topic: c.topic || "general",
        chunkIndex: c.chunkIndex ?? null,  // ✅ giữ thứ tự gốc
        score: cosineSim(queryEmbedding, c.embedding)
      }))
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);

  } catch (err) {
    console.error("❌ searchChunksBySection error:", err.message);
    return searchRelevantChunks(planId, queryEmbedding, limit);
  }
};

// ─────────────────────────────────────────────
// RE-RANK (OPTIONAL - SAFE)
// ─────────────────────────────────────────────

const reRank = async (query, docs) => {
  try {
    // ❗ FIX: disable nếu không cần
    if (!docs?.length || !process.env.HF_TOKEN) {
      return docs;
    }

    const res = await axios.post(
      "https://router.huggingface.co/models/cross-encoder/ms-marco-MiniLM-L6-v2",
      {
        inputs: docs.map(d => ({
          source_sentence: query,
          sentences: [d.content]
        }))
      },
      {
        headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` },
        timeout: 5000 // 🔥 tránh treo
      }
    );

    return docs
      .map((d, i) => ({ ...d, score: res.data?.[i] ?? d.score }))
      .sort((a, b) => b.score - a.score);

  } catch (err) {
    console.warn("⚠️ reRank failed:", err.message);
    return docs;
  }
};

module.exports = {
  searchRelevantChunks,
  searchRelevantChunksByTopic,
  searchChunksBySection,
  reRank
};