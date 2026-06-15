// services/lessonReuseService.js  — OPTIMIZED v2
// ─────────────────────────────────────────────────────────────────────────────
// THAY ĐỔI SO VỚI v1:
//
//  [FIX-1] semanticDiffLesson + searchRelevantChunks KHÔNG còn nằm trong loop.
//          Luồng mới:
//            1. vector search → lấy best candidate vượt threshold + guards
//            2. Fetch lesson document DUY NHẤT candidate đó
//            3. searchRelevantChunks 1 lần duy nhất
//            4. semanticDiffLesson 1 lần duy nhất
//          Giảm từ O(n) LLM calls xuống O(1) per lesson slot.
//
//  [FIX-2] _extractKeywords xử lý đúng tiếng Việt:
//          Thêm bước replace "đ"→"d", "Đ"→"D" trước normalize NFD.
//          Không còn bỏ sót ký tự đặc biệt → guard hoạt động đúng.
//
//  [FIX-3] Context chunk cache per (planId, embeddingKey) trong bộ nhớ runtime.
//          Cùng một plan + query embedding không query MongoDB lại.
//          Cache tự giải phóng khi process restart (không leak).
//
//  [FIX-4] Tách _pickBestCandidate() — single-pass qua ownRaw/publicRaw,
//          trả về candidate đầu tiên vượt threshold + guards mà không fetch
//          Lesson document cho từng candidate bị reject.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const mongoose = require("mongoose");
const Lesson = require("../models/Lesson");
const LessonEmbedding = require("../models/LessonEmbedding");
const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks } = require("./vectorSearchService");

// ─────────────────────────────────────────────
// NGƯỠNG SIMILARITY
// ─────────────────────────────────────────────

const OWN_THRESHOLD = parseFloat(process.env.LESSON_REUSE_OWN_THRESHOLD || "0.88");
const PUBLIC_THRESHOLD = parseFloat(process.env.LESSON_REUSE_PUBLIC_THRESHOLD || "0.92");

// ─────────────────────────────────────────────
// [FIX-3] CONTEXT CHUNK CACHE
// Map key: `${planId}:${embeddingHashPrefix}` → chunks[]
// Dùng Map đơn giản — tự reset khi process restart.
// Max 200 entries để tránh memory leak trên server chạy lâu.
// ─────────────────────────────────────────────

const _chunkCache = new Map();
const CHUNK_CACHE_MAX = 200;

/**
 * Lấy context chunks, dùng cache nếu đã có.
 * embeddingKey: 8 số đầu của embedding (đủ để phân biệt query khác nhau).
 */
const _getContextChunks = async (planId, queryEmbedding, topK = 5) => {
  if (!planId) return [];

  // Key gọn: planId + 8 giá trị đầu của embedding (float → 2 chữ số)
  const embKey = queryEmbedding.slice(0, 20).map(v => v.toFixed(4)).join(",");
  const cacheKey = `${planId}:${embKey}`;

  if (_chunkCache.has(cacheKey)) {
    return _chunkCache.get(cacheKey);
  }

  const chunks = await searchRelevantChunks(planId, queryEmbedding, topK);
  const result = chunks || [];

  // Evict oldest nếu đầy
  if (_chunkCache.size >= CHUNK_CACHE_MAX) {
    const firstKey = _chunkCache.keys().next().value;
    _chunkCache.delete(firstKey);
  }
  _chunkCache.set(cacheKey, result);
  return result;
};

// ─────────────────────────────────────────────
// INTERNAL: Vector search
// ─────────────────────────────────────────────

const _vectorSearchLessonEmbeddings = async (queryEmbedding, atlasFilter, limit = 5) => {
  try {
    const results = await LessonEmbedding.aggregate([
      {
        $vectorSearch: {
          index: "lesson_vector_index",
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: Math.max(50, limit * 10),
          limit: limit + 10,
          filter: atlasFilter,
        },
      },
      {
        $project: {
          lessonId: 1,
          planId: 1,
          ownerId: 1,
          isPublic: 1,
          topicText: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ]);
    return results;
  } catch (err) {
    console.warn("[LessonReuse] Vector search error:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────
// [FIX-2] KEYWORD GUARD — xử lý đúng tiếng Việt
// ─────────────────────────────────────────────

const STOPWORDS = new Set([
  'va', 'cac', 'mot', 'trong', 'la', 'co', 'de', 'duoc', 'voi', 'bai', 'hoc',
  'kien', 'thuc', 've', 'tu', 'cua', 'theo', 'nguoi', 'dung', 'chu', 'nay',
  'tim', 'hieu', 'ap', 'ung', 'phan', 'gioi', 'thieu', 'tong', 'quan',
  'the', 'and', 'of', 'to', 'a', 'in', 'is', 'for', 'on', 'with', 'an', 'it',
  'be', 'as', 'at', 'by', 'this', 'that', 'are', 'from', 'or', 'but', 'not',
  'introduction', 'overview', 'basic', 'advanced',
]);

const _extractKeywords = (text) => {
  return String(text || '')
    .toLowerCase()
    // [FIX-2] Xử lý "đ"/"Đ" trước khi normalize NFD
    // vì "đ" không phân rã thành d + combining diacritic
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // bỏ dấu tổ hợp
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
};

const _keywordOverlap = (textA, textB) => {
  const kwA = new Set(_extractKeywords(textA));
  const kwB = new Set(_extractKeywords(textB));
  if (kwA.size === 0 || kwB.size === 0) return 0;
  let shared = 0;
  for (const w of kwA) { if (kwB.has(w)) shared++; }
  const union = kwA.size + kwB.size - shared;
  return shared / union;
};

const _titleOverlapOk = (oldTopicText, newTopic, newObjective) => {
  const newText = `${newTopic} ${newObjective}`;
  return _keywordOverlap(oldTopicText, newText) >= 0.10;
};

const _objectiveAlignOk = (oldTopicText, newTopic, newObjective) => {
  const newText = `${newTopic} ${newObjective}`;
  return _keywordOverlap(oldTopicText, newText) >= 0.15;
};

// ─────────────────────────────────────────────
// [FIX-4] _pickBestCandidate
// Single-pass: trả về raw record đầu tiên vượt threshold + guards.
// KHÔNG fetch Lesson document ở đây — tránh DB round-trip cho candidates bị reject.
// ─────────────────────────────────────────────

const _pickBestCandidate = (rawResults, {
  threshold,
  excludePlanId,
  excludeOwnerId,   // dùng cho public search (bỏ bài của chính mình)
  excludeLessonId,  // [NEW] skip lesson đang edit
  topic,
  objective,
}) => {
  for (const r of rawResults) {
    if (r.score < threshold) break;
    if (excludePlanId && String(r.planId) === String(excludePlanId)) continue;
    if (excludeOwnerId && String(r.ownerId) === String(excludeOwnerId)) continue;
    if (excludeLessonId && String(r.lessonId) === String(excludeLessonId)) continue;
    const topicText = r.topicText || '';

    if (!_titleOverlapOk(topicText, topic, objective)) {
      console.log(`   [LessonReuse] SKIP score=${r.score.toFixed(3)} — title mismatch: "${topicText.substring(0, 60)}"`);
      continue;
    }
    if (!_objectiveAlignOk(topicText, topic, objective)) {
      console.log(`   [LessonReuse] SKIP score=${r.score.toFixed(3)} — objective divergence: "${topicText.substring(0, 60)}"`);
      continue;
    }

    return r;  // first passing candidate
  }
  return null;
};

// ─────────────────────────────────────────────
// SEMANTIC DIFF (AI) — không thay đổi logic
// ─────────────────────────────────────────────

const semanticDiffLesson = async (oldLesson, newContext) => {
  if (!newContext || newContext.trim() === "") {
    return { action: "REUSE_NGUYEN", missingCoverage: [] };
  }

  const prompt = `Bạn là chuyên gia phân tích nội dung học thuật.
Tôi có một BÀI HỌC CŨ và một ĐOẠN TÀI LIỆU MỚI (context).
Hãy so sánh 2 đoạn này và xác định xem có thể dùng lại BÀI HỌC CŨ cho ĐOẠN TÀI LIỆU MỚI hay không.

- BÀI HỌC CŨ:
${(oldLesson.content || "").substring(0, 3000)}

- TÀI LIỆU MỚI:
${newContext.substring(0, 3000)}

TRẢ LỜI BẰNG ĐỊNH DẠNG JSON CHÍNH XÁC SAU:
{
  "hasNewInfo": boolean,
  "hasChangedInfo": boolean,
  "missingCoverage": ["keyword 1", "keyword 2"],
  "action": "REUSE_NGUYEN" | "REUSE_UPDATE" | "REWRITE"
}

QUY TẮC CHỌN ACTION:
- REUSE_NGUYEN: Bài cũ đã bao phủ 95-100% nội dung tài liệu mới (missingCoverage rỗng).
- REUSE_UPDATE: Tài liệu mới có thêm ví dụ, edge case hoặc kiến thức bổ sung nhỏ.
- REWRITE: Nội dung khác nhau quá nhiều, có kiến thức mới quan trọng.`;

  try {
    const { makeGroqRequest, safeJSONParse } = require("./planService");
    const resText = await makeGroqRequest({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "Chỉ trả về JSON hợp lệ." },
        { role: "user", content: prompt }
      ],
      enforceJSON: true
    });

    return safeJSONParse(resText);
  } catch (err) {
    console.warn("[LessonReuse] Semantic Diff error:", err.message);
    return { action: "REWRITE", missingCoverage: [] };
  }
};

// ─────────────────────────────────────────────
// PUBLIC API — indexLesson (không thay đổi)
// ─────────────────────────────────────────────

const indexLesson = async (lesson, plan) => {
  if (lesson.reusedFrom) return;

  try {
    const exists = await LessonEmbedding.exists({ lessonId: lesson._id });
    if (exists) return;

    const topicText = [lesson.title, lesson.summary]
      .filter(Boolean)
      .join(" ")
      .trim()
      .substring(0, 400);

    if (!topicText) return;

    const embedding = await generateEmbedding(topicText, "passage");
    if (!embedding) {
      console.warn(`[LessonReuse] skip indexLesson vì embedding null cho "${lesson.title}"`);
      return;
    }

    await LessonEmbedding.create({
      lessonId: lesson._id,
      planId: lesson.planId,
      ownerId: plan.owner,
      isPublic: plan.isPublic || false,
      embedding,
      topicText,
    });

    console.log(`   🔖 Indexed lesson: "${lesson.title}"`);
  } catch (err) {
    console.warn(`[LessonReuse] indexLesson failed for "${lesson.title}":`, err.message);
  }
};

// ─────────────────────────────────────────────
// PUBLIC API — findReusableLesson  [FIX-1 CORE]
// ─────────────────────────────────────────────

/**
 * Tìm bài học có thể tái sử dụng.
 *
 * LUỒNG MỚI (v2):
 *   1. generateEmbedding (1 lần)
 *   2. vectorSearch own → _pickBestCandidate (chỉ guards, không fetch Lesson)
 *   3. Nếu có candidate → fetch Lesson (1 DB call)
 *   4. _getContextChunks (cached per planId+embKey)
 *   5. semanticDiffLesson (1 AI call, không phải N)
 *   6. Nếu REWRITE → thử public với cùng quy trình
 *
 * Tổng AI calls: tối đa 2 (1 own + 1 public), thay vì tối đa 20.
 */
const findReusableLesson = async (userId, topic, objective, opts = {}) => {
  const { currentPlanId } = opts;

  const topicText = [topic, objective].filter(Boolean).join(' ').trim();
  if (!topicText) return null;

  let queryEmbedding;
  try {
    queryEmbedding = await generateEmbedding(topicText, 'query');
  } catch (err) {
    console.warn('[LessonReuse] Embedding generation failed:', err.message);
    return null;
  }

  const userOid = new mongoose.Types.ObjectId(userId);

  // ── Ưu tiên 1: Bài của chính người dùng ──────────────────────────────────
  const ownRaw = await _vectorSearchLessonEmbeddings(
    queryEmbedding,
    { ownerId: userOid },
    10
  );

  const ownCandidate = _pickBestCandidate(ownRaw, {
    threshold: OWN_THRESHOLD,
    excludePlanId: currentPlanId,
    topic,
    objective,
  });

  if (ownCandidate) {
    const lesson = await Lesson.findOne({ _id: ownCandidate.lessonId, isDeleted: false }).lean();
    if (lesson) {
      // [FIX-1] searchRelevantChunks + diff chỉ gọi 1 lần cho candidate duy nhất
      const chunks = await _getContextChunks(currentPlanId, queryEmbedding, 5);
      const newContext = chunks.map(c => c.content).join("\n");

      const diff = await semanticDiffLesson(lesson, newContext);
      console.log(`   [LessonReuse] own diff=${diff.action}, missing=${diff.missingCoverage.length}, score=${ownCandidate.score.toFixed(3)}`);

      if (diff.action !== "REWRITE") {
        return {
          lesson,
          score: ownCandidate.score,
          source: 'own',
          action: diff.action,
          diff,
          newContext,
        };
      }
      // REWRITE → thử public
    }
  }

  // ── Ưu tiên 2: Bài từ khoá học công khai ─────────────────────────────────
  const publicRaw = await _vectorSearchLessonEmbeddings(
    queryEmbedding,
    { isPublic: true },
    10
  );

  const publicCandidate = _pickBestCandidate(publicRaw, {
    threshold: PUBLIC_THRESHOLD,
    excludePlanId: currentPlanId,
    excludeOwnerId: userId,   // bỏ bài của chính mình
    excludeLessonId: ownCandidate?.lessonId,
    topic,
    objective,
  });

  if (publicCandidate) {
    const lesson = await Lesson.findOne({ _id: publicCandidate.lessonId, isDeleted: false }).lean();
    if (lesson) {
      // [FIX-1] cache hit nếu cùng planId + queryEmbedding (thường sẽ hit vì own đã gọi)
      const chunks = await _getContextChunks(currentPlanId, queryEmbedding, 5);
      const newContext = chunks.map(c => c.content).join("\n");

      const diff = await semanticDiffLesson(lesson, newContext);
      console.log(`   [LessonReuse] public diff=${diff.action}, missing=${diff.missingCoverage.length}, score=${publicCandidate.score.toFixed(3)}`);

      if (diff.action !== "REWRITE") {
        return {
          lesson,
          score: publicCandidate.score,
          source: 'public',
          action: diff.action,
          diff,
          newContext,
        };
      }
    }
  }

  return null;
};

// ─────────────────────────────────────────────
// cloneLesson / patchLesson / syncPlanPublicStatus
// Không thay đổi logic — giữ nguyên
// ─────────────────────────────────────────────

const cloneLesson = async (sourceLesson, targetPlanId, newDayNumber, opts = {}) => {
  const { version = 'v1', missingCoverage = [] } = opts;
  return await Lesson.create({
    planId: targetPlanId,
    dayNumber: newDayNumber,
    title: sourceLesson.title,
    content: sourceLesson.content,
    summary: sourceLesson.summary,
    importantNotes: sourceLesson.importantNotes || [],
    quiz: sourceLesson.quiz || [],
    status: newDayNumber === 1 ? "in-progress" : "locked",
    reusedFrom: sourceLesson._id,
    version,
    coverage: missingCoverage.length > 0
      ? [...(sourceLesson.coverage || []), ...missingCoverage]
      : (sourceLesson.coverage || []),
  });
};

const patchLesson = async (sourceLesson, targetPlanId, newDayNumber, missingCoverage, newContext, currentVersion) => {
  let patchedContent = sourceLesson.content;

  if (missingCoverage && missingCoverage.length > 0) {
    const prompt = `Bạn là một AI giảng viên kỹ thuật.
Dưới đây là BÀI HỌC CŨ:
${sourceLesson.content.substring(0, 2500)}

Bài học này ĐANG THIẾU các khái niệm/thông tin sau:
${missingCoverage.join(", ")}

Dựa vào TÀI LIỆU MỚI dưới đây, hãy VIẾT BỔ SUNG một phần nội dung (Markdown) giải thích về những thông tin còn thiếu này.
TÀI LIỆU MỚI:
${newContext.substring(0, 3000)}

QUY TẮC:
- KHÔNG viết lại bài cũ.
- CHỈ viết phần nội dung cần bổ sung để nối tiếp vào bài cũ.
- Sử dụng tiêu đề (VD: ### Bổ sung: ...)
- Ngắn gọn, bám sát tài liệu mới.`;

    try {
      const { makeGroqPlainRequest } = require("./planService");
      const patch = await makeGroqPlainRequest({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "Chỉ xuất nội dung Markdown bổ sung, không có lời chào hay giải thích ngoài." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      });
      if (patch && patch.trim()) {
        patchedContent += "\n\n" + patch.trim();
      }
    } catch (err) {
      console.warn("[LessonReuse] Patch error:", err.message);
    }
  }

  let nextVersion = "v2";
  if (currentVersion && currentVersion.startsWith("v")) {
    const vNum = parseInt(currentVersion.substring(1));
    if (!isNaN(vNum)) nextVersion = `v${vNum + 1}`;
  }

  return await Lesson.create({
    planId: targetPlanId,
    dayNumber: newDayNumber,
    title: sourceLesson.title,
    content: patchedContent,
    summary: sourceLesson.summary,
    importantNotes: sourceLesson.importantNotes || [],
    quiz: sourceLesson.quiz || [],
    status: newDayNumber === 1 ? "in-progress" : "locked",
    reusedFrom: sourceLesson._id,
    version: nextVersion,
    coverage: missingCoverage.length > 0
      ? [...(sourceLesson.coverage || []), ...missingCoverage]
      : (sourceLesson.coverage || []),
  });
};

const syncPlanPublicStatus = async (planId, isPublic) => {
  try {
    await LessonEmbedding.updateMany({ planId }, { isPublic });
    console.log(`[LessonReuse] Synced isPublic=${isPublic} for planId=${planId}`);
  } catch (err) {
    console.warn("[LessonReuse] syncPlanPublicStatus failed:", err.message);
  }
};

module.exports = {
  indexLesson,
  findReusableLesson,
  cloneLesson,
  patchLesson,
  syncPlanPublicStatus,
};