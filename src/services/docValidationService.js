// services/docValidationService.js
// ─────────────────────────────────────────────────────────────────────────────
// Kiểm tra chất lượng tài liệu TRƯỚC khi tạo lộ trình học tập:
//   1. validateDocumentQuality  — đủ dài, đủ chủ đề, không rỗng
//   2. verifyContentAccuracy    — AI kiểm tra tính đúng đắn của tài liệu
//   3. assessDepthSuitability   — đánh giá tài liệu có phù hợp với mục tiêu không
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const MODEL = "llama-3.1-8b-instant";
const MODEL_SMART = "llama-3.3-70b-versatile";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const safeGroq = async (messages, model = MODEL, maxTokens = 1200, enforceJSON = true) => {
  const { makeGroqRequest } = require("./planService");
  const raw = await makeGroqRequest({
    messages,
    model,
    maxTokens,
    enforceJSON
  });
  return raw;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. BASIC QUALITY METRICS (rule-based, không cần AI)
// ─────────────────────────────────────────────────────────────────────────────
const getBasicMetrics = (text) => {
  const words    = text.split(/\s+/).filter(Boolean).length;
  const chars    = text.length;
  const lines    = text.split(/\r?\n/).filter(l => l.trim()).length;
  const sections = (text.match(/^#{1,3}\s|^\d+\.\s|^CHƯƠNG\s/gim) || []).length;

  // Tỉ lệ ký tự có nghĩa (chữ/số) so với tổng
  const meaningfulChars = (text.match(/[a-zA-ZÀ-ỹ0-9]/g) || []).length;
  const meaningfulRatio = chars > 0 ? meaningfulChars / chars : 0;

  // Số câu hoàn chỉnh
  const sentences = (text.match(/[.!?]\s/g) || []).length;

  return { words, chars, lines, sections, meaningfulRatio, sentences };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. AI CONTENT ACCURACY CHECK
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Gọi AI để đánh giá:
 * - Tài liệu có chứa thông tin thực tế, có thể dạy học không?
 * - Có dấu hiệu nội dung sai lệch, mâu thuẫn nội bộ, hoặc bịa đặt không?
 * - Phù hợp với mục tiêu học (focus, depth) không?
 */
const verifyContentAccuracy = async (text, focus, depth) => {
  const sample = text.slice(0, 3500); // dùng 3500 ký tự đầu để đánh giá

  const focusLabel = focus === "practice" ? "Thực hành ứng dụng" : "Lý thuyết hệ thống";
  const depthLabel = depth === "deep" ? "Chuyên sâu (nghiên cứu)" : "Cơ bản (nhập môn)";

  const prompt = `Bạn là chuyên gia đánh giá chất lượng tài liệu học thuật.

Đọc đoạn trích tài liệu bên dưới và đánh giá theo các tiêu chí:

MỤC TIÊU HỌC CỦA NGƯỜI DÙNG:
- Trọng tâm: ${focusLabel}
- Mức độ: ${depthLabel}

TÀI LIỆU:
---
${sample}
---

Trả về JSON với cấu trúc sau:
{
  "isTeachable": true/false,           // Tài liệu có đủ nội dung để dạy học không?
  "hasAccuracyConcerns": true/false,   // Có dấu hiệu sai lệch / mâu thuẫn nội bộ không?
  "suitableForDepth": true/false,      // Phù hợp với mức độ "${depthLabel}" không?
  "suitableForFocus": true/false,      // Phù hợp với trọng tâm "${focusLabel}" không?
  "detectedDomain": "...",             // Lĩnh vực chính (VD: "Lập trình SQL", "Toán học", "Kinh doanh")
  "contentQualityScore": 0-100,        // Điểm chất lượng nội dung (0=rỗng/rác, 100=xuất sắc)
  "depthScore": 0-100,                 // Mức độ chuyên sâu thực tế trong tài liệu (0=quá cơ bản, 100=rất chuyên sâu)
  "warnings": ["..."],                 // Danh sách cảnh báo (nếu có), mảng rỗng nếu không có
  "recommendation": "proceed|warn|reject",  // proceed=OK, warn=cho qua nhưng cảnh báo, reject=không nên tạo
  "recommendationReason": "..."        // Lý do ngắn gọn
}`;

  try {
    const raw = await safeGroq(
      [{ role: "user", content: prompt }],
      MODEL_SMART,
      800,
      true
    );

    const parsed = JSON.parse(raw);
    return {
      isTeachable:          Boolean(parsed.isTeachable),
      hasAccuracyConcerns:  Boolean(parsed.hasAccuracyConcerns),
      suitableForDepth:     Boolean(parsed.suitableForDepth),
      suitableForFocus:     Boolean(parsed.suitableForFocus),
      detectedDomain:       String(parsed.detectedDomain || "Không xác định"),
      contentQualityScore:  Number(parsed.contentQualityScore) || 50,
      depthScore:           Number(parsed.depthScore) || 50,
      warnings:             Array.isArray(parsed.warnings) ? parsed.warnings : [],
      recommendation:       parsed.recommendation || "proceed",
      recommendationReason: String(parsed.recommendationReason || ""),
    };
  } catch (err) {
    console.warn("[docValidation] AI accuracy check failed:", err.message);
    // fallback — không chặn pipeline
    return {
      isTeachable: true,
      hasAccuracyConcerns: false,
      suitableForDepth: true,
      suitableForFocus: true,
      detectedDomain: "Không xác định",
      contentQualityScore: 60,
      depthScore: 50,
      warnings: [],
      recommendation: "proceed",
      recommendationReason: "AI validation không khả dụng, tiếp tục xử lý.",
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. MAIN VALIDATION FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
/**
 * validateDocument(text, { focus, depth })
 * Trả về ValidationResult:
 * {
 *   passed: boolean,            // true = OK tạo lộ trình
 *   level: "ok"|"warn"|"error", // mức độ kết quả
 *   metrics: { words, ... },    // thống kê cơ bản
 *   aiResult: { ... },          // kết quả AI
 *   issues: string[],           // danh sách vấn đề
 *   depthGapWarning: string|null // cảnh báo mức độ không khớp
 * }
 */
const validateDocument = async (text, { focus = "theory", depth = "basic" } = {}) => {
  console.log(`[docValidation] Bắt đầu validation: focus=${focus}, depth=${depth}`);

  const issues = [];
  let level = "ok";

  // ── 1. Basic metrics ──────────────────────────────────────────────────────
  const metrics = getBasicMetrics(text);
  console.log("[docValidation] Metrics:", metrics);

  if (metrics.words < 150) {
    issues.push(`Tài liệu quá ngắn (${metrics.words} từ). Cần tối thiểu 150 từ để tạo lộ trình.`);
    level = "error";
  } else if (metrics.words < 400) {
    issues.push(`Tài liệu khá ngắn (${metrics.words} từ). Nội dung bài học có thể không đủ chi tiết.`);
    level = "warn";
  }

  if (metrics.meaningfulRatio < 0.4) {
    issues.push("Tài liệu chứa nhiều ký tự đặc biệt/rác. Có thể trích xuất PDF bị lỗi.");
    level = level === "ok" ? "warn" : level;
  }

  if (metrics.sentences < 5) {
    issues.push("Tài liệu không có câu hoàn chỉnh — có thể chỉ là tiêu đề/bảng biểu.");
    level = level === "ok" ? "warn" : level;
  }

  // ── 2. AI validation ──────────────────────────────────────────────────────
  let aiResult = null;

  if (level !== "error") {
    aiResult = await verifyContentAccuracy(text, focus, depth);

    if (!aiResult.isTeachable) {
      issues.push("AI đánh giá: Tài liệu không có đủ nội dung học thuật để giảng dạy.");
      level = "error";
    }

    if (aiResult.hasAccuracyConcerns) {
      issues.push("AI phát hiện dấu hiệu nội dung có thể không chính xác hoặc mâu thuẫn nội bộ.");
      level = level === "ok" ? "warn" : level;
    }

    if (aiResult.contentQualityScore < 30) {
      issues.push(`Điểm chất lượng nội dung thấp (${aiResult.contentQualityScore}/100). Nội dung có thể là rác hoặc không phù hợp.`);
      level = "error";
    } else if (aiResult.contentQualityScore < 55) {
      issues.push(`Chất lượng nội dung ở mức trung bình (${aiResult.contentQualityScore}/100). Bài học có thể thiếu chi tiết.`);
      level = level === "ok" ? "warn" : level;
    }

    if (aiResult.recommendation === "reject") {
      level = "error";
      issues.push(`AI khuyến nghị từ chối: ${aiResult.recommendationReason}`);
    } else if (aiResult.recommendation === "warn") {
      level = level === "ok" ? "warn" : level;
    }

    // Cảnh báo từ AI
    if (Array.isArray(aiResult.warnings)) {
      aiResult.warnings.forEach(w => {
        if (!issues.includes(w)) issues.push(w);
      });
    }
  }

  // ── 3. Depth gap check ────────────────────────────────────────────────────
  let depthGapWarning = null;
  if (aiResult) {
    const docDepth = aiResult.depthScore;
    if (depth === "deep" && docDepth < 45) {
      depthGapWarning = `Tài liệu có mức độ chuyên sâu thực tế thấp (${docDepth}/100) so với mục tiêu "Chuyên sâu". Nội dung bài học có thể không đủ sâu.`;
      level = level === "ok" ? "warn" : level;
    } else if (depth === "basic" && docDepth > 80) {
      depthGapWarning = `Tài liệu có nội dung khá chuyên sâu (${docDepth}/100) so với mục tiêu "Cơ bản". Bạn có thể chuyển sang mục tiêu "Chuyên sâu" để tận dụng tốt hơn.`;
      // Không phải lỗi, chỉ gợi ý
    }
  }

  const passed = level !== "error";

  console.log(`[docValidation] Kết quả: level=${level}, passed=${passed}, issues=${issues.length}`);

  return {
    passed,
    level,
    metrics,
    aiResult,
    issues,
    depthGapWarning,
  };
};

module.exports = { validateDocument, getBasicMetrics, verifyContentAccuracy };
