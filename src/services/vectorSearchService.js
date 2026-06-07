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
            numCandidates: 100, // Tăng numCandidates để tăng cơ hội tìm thấy child propositions tốt
            limit: limit * 4,    // Lấy nhiều hơn để sau đó map về Parent unique
            filter: { planId: oid },
          },
        },
        {
          $project: {
            content: 1,
            section: 1,
            topic: 1,
            isChild: 1,
            parentId: 1,
            chunkIndex: 1,
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

    // ── Parent-Child RAG Resolution ─────────────────────────────────────
    const resolvedParents = await resolveParentDocs(oid, results);
    return postProcess(resolvedParents, limit);

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
      results = await Chunk.aggregate([
        {
          $vectorSearch: {
            index: "vector_index",
            path: "embedding",
            queryVector: queryEmbedding,
            numCandidates: 150,
            limit: limit * 8,
            filter: { planId: oid },
          },
        },
        // Post-filter theo topic
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
            isChild: 1,
            parentId: 1,
            chunkIndex: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
        { $limit: limit * 4 },
      ]);
    } catch (err) {
      console.warn("⚠️ Topic vector search failed:", err.message);
    }

    if (!results?.length) {
      console.warn("⚠️ Topic filter → fallback DB");
      return fallbackTopicChunks(oid, allowedTopics, limit);
    }

    const resolvedParents = await resolveParentDocs(oid, results);
    return postProcess(resolvedParents, limit);

  } catch (error) {
    console.error("❌ searchRelevantChunksByTopic error:", error.message);
    return searchRelevantChunks(planId, queryEmbedding, limit);
  }
};

// ─────────────────────────────────────────────
// RESOLVE PARENT DOCUMENTS FROM CHILD MATCHES
// ─────────────────────────────────────────────

const resolveParentDocs = async (oid, results) => {
  if (!results?.length) return [];

  // Lấy list parentIds (nếu doc là child thì lấy parentId, nếu không lấy _id)
  const parentIds = results.map(r => r.isChild && r.parentId ? r.parentId : r._id);

  // Query DB lấy thông tin đầy đủ của các Parent
  const parents = await Chunk.find({
    planId: oid,
    _id: { $in: parentIds },
    isChild: false // Chỉ lấy Parent Nodes thực sự
  }).lean();

  // Map parentId string sang Parent Object
  const parentMap = new Map();
  for (const p of parents) {
    parentMap.set(p._id.toString(), {
      ...p,
      score: 0 // Khởi tạo score
    });
  }

  // Gán score cho parent bằng max score của các child match
  for (const r of results) {
    const targetId = (r.isChild && r.parentId ? r.parentId : r._id).toString();
    if (parentMap.has(targetId)) {
      const parentNode = parentMap.get(targetId);
      if (r.score > parentNode.score) {
        parentNode.score = r.score;
      }
    }
  }

  // Trả về array parent docs đã gán score, sort theo score giảm dần
  return Array.from(parentMap.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
};

// ─────────────────────────────────────────────
// FALLBACK
// ─────────────────────────────────────────────

const fallbackRandomChunks = async (oid, limit) => {
  // Chỉ lấy Parent chunks cho generator
  const docs = await Chunk.find({ planId: oid, isChild: false })
    .select("content section topic chunkIndex")
    .limit(limit * 2)
    .lean();

  console.warn(`⚠️ Fallback DB → ${docs.length} parent chunks`);

  return postProcess(docs.map(d => ({ ...d, score: 1 })), limit);
};

// Fallback: filter theo topic thôi, không có vector
const fallbackTopicChunks = async (oid, allowedTopics, limit) => {
  const docs = await Chunk.find({
    planId: oid,
    topic: { $in: allowedTopics },
    isChild: false
  })
    .select("content section topic chunkIndex")
    .limit(limit * 2)
    .lean();

  console.warn(`⚠️ Topic Fallback DB → ${docs.length} parent chunks`);

  if (!docs.length) {
    return fallbackRandomChunks(oid, limit);
  }

  return postProcess(docs.map(d => ({ ...d, score: 1 })), limit);
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

  const final = unique.slice(0, limit).map(r => ({
    content: r.content.substring(0, 3000), // Tăng giới hạn để không mất chữ
    section: r.section || "",
    topic: r.topic || "general",
    chunkIndex: r.chunkIndex,
    score: r.score || 0.5
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
 * Từ mỗi coveredSection tạo nhiều mẫu regex (3 tier) để khớp Chunk.section.
 *
 * Tier 1 — Exact title substring:  "1.1 Stored Procedure" → regex trên section field
 * Tier 2 — Section number only:    "1.1" → khớp chunk bất kể AI đặt tiêu đề gì
 * Tier 3 — Keyword-based:          Tài liệu không đánh số (luật, y khoa, thematic headings)
 *                                   Trích cụm 2 từ quan trọng để tìm kiếm
 *
 * Domain-agnostic: hoạt động với luật (Điều, Chương), y khoa, vật lý, kinh tế, lập trình...
 */
const buildSectionSearchPatterns = (coveredSections) => {
  const or = [];
  const seen = new Set();

  const pushPattern = (fragment, field = "section") => {
    const f = String(fragment || "").trim();
    if (f.length < 2) return;
    // Tăng từ 40 → 60 để khớp tiêu đề dài hơn
    const rx = escapeRegex(f).substring(0, 60);
    if (rx.length < 2) return;
    const key = `${field}|${rx.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    or.push({ [field]: { $regex: rx, $options: "i" } });
  };

  /**
   * Trích từ khoá >= 4 ký tự, bỏ stop word đa ngôn ngữ.
   * Strip diacritics → tăng khả năng khớp khi encoding section khác nhau.
   */
  const extractKeywords = (text) => {
    const stopwords = new Set([
      "cua", "trong", "cac", "mot", "cho", "voi", "nay", "ve", "theo",
      "duoc", "bang", "khi", "sau", "truoc", "den", "tu", "tai", "nhung",
      "the", "and", "for", "with", "that", "this", "are", "have", "has",
      "from", "not", "but", "will", "all"
    ]);
    return text
      .replace(/^#+\s*/, "")
      .replace(/^\d+(?:\.\d+)*\s+/, "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .split(/[\s\-_.,:;()[\]\/]+/)
      .filter(w => w.length >= 4 && !stopwords.has(w) && !/^\d+$/.test(w));
  };

  for (const raw of coveredSections) {
    const norm = normalizeSectionQuery(raw);
    if (!norm) continue;

    const m = norm.match(/^(\d+(?:\.\d+)+)\s+(.+)/);
    if (m) {
      const sectionNum = m[1];
      const titlePart = m[2].trim();

      // ── Tier 1: Section number alone ─────────────────────────────────────────
      // KEY: "1.1" khớp "1.1 Bất kỳ tiêu đề nào" trong DB
      pushPattern(sectionNum, "section");

      // ── Tier 2: Section number at start of chunk content ─────────────────────
      pushPattern(`${sectionNum} `, "content");

      // ── Tier 3: First 3 meaningful words of title ────────────────────────────
      const titleWords = titlePart
        .split(/\s+/)
        .filter(w => w.length >= 3)
        .slice(0, 3)
        .join(" ");
      if (titleWords.length >= 4) {
        const shortPhrase = `${sectionNum} ${titleWords}`.substring(0, 50);
        pushPattern(shortPhrase, "section");
      }

      // ── Tier 4: First 2 title keywords ───────────────────────────────────────
      const keywords = extractKeywords(norm);
      for (const kw of keywords.slice(0, 3)) {
        if (kw.length >= 5) pushPattern(kw, "content");
      }

    } else {
      // ── Non-numbered heading ─────────────────────────────────────────────────
      const origWords = norm
        .replace(/^#+\s*/, "")
        .split(/\s+/)
        .filter(w => w.length >= 3);

      if (origWords.length >= 2) {
        pushPattern(origWords.slice(0, 2).join(" "), "section");
        pushPattern(origWords.slice(0, 2).join(" "), "content");
      } else if (origWords.length === 1) {
        pushPattern(origWords[0], "section");
      }

      const keywords = extractKeywords(norm);
      for (const kw of keywords.slice(0, 2)) {
        if (kw.length >= 5) pushPattern(kw, "content");
      }
    }
  }

  return or;
};

const searchChunksBySection = async (planId, coveredSections, queryEmbedding, limit = 6, maxChars = 6500) => {
  try {
    const oid = new mongoose.Types.ObjectId(planId);

    if (!coveredSections?.length) {
      return searchRelevantChunks(planId, queryEmbedding, limit);
    }

    const patterns = buildSectionSearchPatterns(coveredSections);
    if (!patterns.length) {
      return searchRelevantChunks(planId, queryEmbedding, limit);
    }

    // 1. Tìm các chunk khớp trực tiếp với regex patterns
    const matchedChunks = await Chunk.find({
      planId: oid,
      isChild: false, // CHỈ tìm kiếm trên Parent Chunks
      $or: patterns
    })
      .select("content section embedding chunkIndex")
      .sort({ chunkIndex: 1 })
      .lean();

    let chunks = [...matchedChunks];

    // ✔ FIX 1: Lấy thêm các chunk lân cận liền kề (idx + 1, idx + 2) để tăng độ phủ (Coverage-aware retrieval)
    // Đảm bảo không bỏ sót các sub-topics quan trọng nằm ngay sau tiêu đề chính (ví dụ: break/continue sau for/while)
    if (matchedChunks.length > 0) {
      const matchedIndexes = new Set(matchedChunks.map(c => c.chunkIndex));
      const neighborIndexes = [];

      for (const c of matchedChunks) {
        if (typeof c.chunkIndex === 'number') {
          if (!matchedIndexes.has(c.chunkIndex + 1)) neighborIndexes.push(c.chunkIndex + 1);
          if (!matchedIndexes.has(c.chunkIndex + 2)) neighborIndexes.push(c.chunkIndex + 2);
        }
      }

      if (neighborIndexes.length > 0) {
        const neighbors = await Chunk.find({
          planId: oid,
          isChild: false,
          chunkIndex: { $in: neighborIndexes }
        })
          .select("content section embedding chunkIndex")
          .lean();

        console.log(`📂 [RAG Neighbor] Đã nạp thêm ${neighbors.length} chunks lân cận để tăng độ phủ.`);
        chunks.push(...neighbors);
      }
    }

    console.log(`📂 Section search → ${chunks.length} total parent chunks matched | sections: ${coveredSections.slice(0, 2).join(', ')}`);

    if (!chunks.length) {
      // Retry: chỉ dùng số mục (bỏ title)
      const numOnlyPatterns = coveredSections
        .map(s => (normalizeSectionQuery(s).match(/^(\d+(?:\.\d+)+)/) || [])[1])
        .filter(Boolean)
        .flatMap(n => [
          { section: { $regex: `^${escapeRegex(n)}`, $options: "i" } },
          { content: { $regex: `^${escapeRegex(n)}\\s`, $options: "m" } },
        ]);

      if (numOnlyPatterns.length) {
        const retry = await Chunk.find({
          planId: oid,
          isChild: false,
          $or: numOnlyPatterns
        })
          .select("content section embedding chunkIndex")
          .sort({ chunkIndex: 1 })
          .lean();
        console.log(`📂 Section retry (num-only) → ${retry.length} parent chunks`);
        chunks.push(...retry);
      }

      if (!chunks.length) {
        console.warn(`[SectionSearch] No chunks found for sections: ${coveredSections.slice(0, 3).join(', ')} → global vector fallback`);
        return searchRelevantChunks(planId, queryEmbedding, limit);
      }
    }

    // ── Score + re-order ─────────────────────────────────────────────────────────
    const hasValidEmbedding = Array.isArray(queryEmbedding) && queryEmbedding.length > 0;
    const MIN_SECTION_SCORE = 0.20;

    const scored = chunks.map(c => ({
      ...c,
      score: hasValidEmbedding && Array.isArray(c.embedding)
        ? cosineSim(queryEmbedding, c.embedding)
        : 1,
    }));

    const filtered = hasValidEmbedding && scored.filter(c => c.score >= MIN_SECTION_SCORE).length >= 2
      ? scored.filter(c => c.score >= MIN_SECTION_SCORE)
      : scored;

    // Sắp xếp theo score giảm dần
    const sortedByScore = [...filtered].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // ✔ FIX 2: Chống hiện tượng Lost-in-the-Middle (Stanford Research)
    // Sắp xếp các chunks có độ quan trọng cao nhất ở ĐẦU và CUỐI context, đẩy chunks phụ trợ vào giữa
    const ordered = [];
    for (let i = 0; i < sortedByScore.length; i++) {
      if (i % 2 === 0) {
        ordered.push(sortedByScore[i]); // Đưa chunk quan trọng chẵn vào cuối context
      } else {
        ordered.unshift(sortedByScore[i]); // Đưa chunk quan trọng lẻ lên đầu context
      }
    }

    // ── Select + budget ─────────────────────────────────────────────────────────
    const selected = [];
    let totalChars = 0;
    const perChunkMax = 3000;

    for (const c of ordered) {
      const content = String(c.content || "").substring(0, perChunkMax).trim();
      if (!content || content.length < 40) continue;

      if (totalChars + content.length > maxChars && selected.length >= 2) break;

      selected.push({
        content,
        section: c.section || "",
        topic: c.topic || "general",
        chunkIndex: c.chunkIndex,
        score: c.score ?? 1,
      });
      totalChars += content.length;
      if (selected.length >= limit) break;
    }

    console.log(`📂 Section final: ${selected.length} chunks | ~${totalChars} chars`);
    return selected.length ? selected : searchRelevantChunks(planId, queryEmbedding, limit);

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
        timeout: 5000
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
