// services/docValidationService.js
// ─────────────────────────────────────────────────────────────────────────────
// Kiểm tra chất lượng tài liệu TRƯỚC khi tạo lộ trình học tập:
//   1. validateDocumentQuality  — đủ dài, đủ chủ đề, không rỗng
//   2. verifyContentAccuracy    — AI kiểm tra tính đúng đắn của tài liệu
//   3. assessDepthSuitability   — đánh giá tài liệu có phù hợp với mục tiêu không
//
// CHANGELOG v2:
//   - meaningfulRatio mở rộng để tính ký tự kỹ thuật hợp lệ (SQL, code, math...)
//   - AI prompt tách biệt "teachable?" khỏi "khớp focus/depth?"
//   - suitableForFocus / suitableForDepth chỉ tạo warning, KHÔNG reject
//   - Hỗ trợ tài liệu đa chủ đề (code, SQL, toán, kinh doanh, khoa học...)
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

/**
 * Phân loại sơ bộ loại tài liệu dựa trên nội dung.
 * Dùng để điều chỉnh ngưỡng đánh giá cho từng loại.
 */
const detectDocumentType = (text) => {
  const sample = text.slice(0, 5000).toLowerCase();

  // Tín hiệu lập trình / kỹ thuật
  const codeSignals = [
    /\b(select|insert|update|delete|create table|drop|alter|join|where|group by)\b/i,
    /\b(function|const|let|var|class|import|export|return|if\s*\(|for\s*\()\b/,
    /[{}();].*[{}();]/,
    /```[\s\S]{20,}```/,
    /^\s*(def |class |import |from )\w/m,
  ];

  // Tín hiệu toán / khoa học
  const mathSignals = [
    /[∑∏∫√≤≥≈±×÷→←⇒⇔∈∉∩∪∀∃]/,
    /\$[^$]{3,}\$/,
    /\\\[[\s\S]{3,}\\\]/,
    /\b(theorem|lemma|proof|corollary|equation)\b/i,
  ];

  const codeHits = codeSignals.filter(r => r.test(sample)).length;
  const mathHits = mathSignals.filter(r => r.test(sample)).length;

  if (codeHits >= 2) return "technical"; // SQL, code, lập trình
  if (mathHits >= 2) return "math";
  return "general";
};

/**
 * Tính tỉ lệ ký tự "có ý nghĩa" theo loại tài liệu.
 *
 * BUG CŨ: chỉ đếm [a-zA-ZÀ-ỹ0-9] → tài liệu SQL/code bị phạt oan vì
 *         _, (, ), ;, *, --, =, <, > đều là ký tự hợp lệ trong kỹ thuật.
 *
 * FIX v2: mở rộng tập ký tự hợp lệ cho tài liệu kỹ thuật + toán học.
 */
const calcMeaningfulRatio = (text, docType) => {
  const chars = text.length;
  if (chars === 0) return 1;

  let meaningful;

  if (docType === "technical") {
    // Chấp nhận thêm: _, (, ), ;, {, }, [, ], =, <, >, *, /, -, +, ., ,, @, #, $, %, ^, &, |, \
    meaningful = (text.match(/[a-zA-ZÀ-ỹ0-9_(){}\[\];=<>*\/+\-.,@#$%^&|\\`'"!?:~]/g) || []).length;
  } else if (docType === "math") {
    // Chấp nhận ký tự toán học Unicode
    meaningful = (text.match(/[a-zA-ZÀ-ỹ0-9_=+\-*/^.,∑∏∫√≤≥≈±×÷→←⇒⇔∈∉∩∪∀∃αβγδεζηθλμνξπρστφχψω]/g) || []).length;
  } else {
    // Văn bản thông thường
    meaningful = (text.match(/[a-zA-ZÀ-ỹ0-9.,!?;:'"()\-]/g) || []).length;
  }

  return meaningful / chars;
};

const getBasicMetrics = (text) => {
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
  const sections = (text.match(/^#{1,3}\s|^\d+\.\s|^CHƯƠNG\s/gim) || []).length;

  const docType = detectDocumentType(text);
  const meaningfulRatio = calcMeaningfulRatio(text, docType);

  // Số câu hoàn chỉnh — với code thì dùng số dòng có nội dung thay thế
  const sentences = docType === "technical"
    ? lines  // code/SQL: dùng số dòng thay cho câu
    : (text.match(/[.!?]\s/g) || []).length;

  return { words, chars, lines, sections, meaningfulRatio, sentences, docType };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. AI CONTENT ACCURACY CHECK (v2 — tách biệt teachable vs focus/depth)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Gọi AI để đánh giá:
 * - Tài liệu có chứa thông tin thực tế, có thể dạy học không? (BLOCKING)
 * - Có dấu hiệu nội dung sai lệch, mâu thuẫn nội bộ không? (WARNING)
 * - Gợi ý: tài liệu phù hợp với focus/depth ở mức nào? (ADVISORY, không block)
 *
 * THAY ĐỔI QUAN TRỌNG so với v1:
 * - "suitableForFocus" và "suitableForDepth" CHỈ là thông tin tham khảo.
 *   Focus/depth là mục tiêu CỦA NGƯỜI HỌC, không phải tiêu chí chọn tài liệu.
 *   → Một tài liệu SQL hoàn toàn hợp lệ dù người dùng chọn focus="theory".
 *   → AI không được dùng 2 trường này để reject tài liệu.
 */
const verifyContentAccuracy = async (text, focus, depth) => {
  const sample = text.slice(0, 3500);

  const focusLabel = focus === "practice" ? "Thực hành ứng dụng" : "Lý thuyết hệ thống";
  const depthLabel = depth === "deep" ? "Chuyên sâu (nghiên cứu)" : "Cơ bản (nhập môn)";

  const prompt = `Bạn là chuyên gia đánh giá chất lượng tài liệu học thuật.

Đọc đoạn trích tài liệu bên dưới. Nhiệm vụ của bạn là đánh giá **tài liệu có đủ chất lượng để dạy học không** — bất kể chủ đề là gì (lập trình, SQL, toán học, kinh doanh, khoa học, ngoại ngữ, v.v.).

THÔNG TIN THAM KHẢO VỀ NGƯỜI HỌC (chỉ để điều chỉnh gợi ý, KHÔNG dùng để từ chối tài liệu):
- Phong cách học: ${focusLabel}
- Mức độ mong muốn: ${depthLabel}

LƯU Ý QUAN TRỌNG:
- "suitableForFocus" và "suitableForDepth" CHỈ là gợi ý tham khảo.
  Chúng KHÔNG phải tiêu chí để reject. Mọi chủ đề tài liệu đều có thể học theo cả lý thuyết lẫn thực hành.
- Một tài liệu SQL, code, toán học hay kinh doanh đều là hợp lệ.
- Chỉ reject khi tài liệu: hoàn toàn rỗng, là rác không có nội dung, hoặc có mâu thuẫn nội bộ nghiêm trọng.

TÀI LIỆU:
---
${sample}
---

Trả về JSON với cấu trúc sau (không có markdown, không có preamble):
{
  "isTeachable": true/false,           // Tài liệu có đủ nội dung để dạy học không? (false chỉ khi rỗng/rác)
  "hasAccuracyConcerns": true/false,   // Có dấu hiệu sai lệch / mâu thuẫn nội bộ rõ ràng không?
  "detectedDomain": "...",             // Lĩnh vực chính (VD: "Lập trình SQL", "Toán học", "Kinh doanh", "Lịch sử"...)
  "contentQualityScore": 0-100,        // Điểm chất lượng nội dung học thuật (0=rỗng/rác, 100=xuất sắc)
  "depthScore": 0-100,                 // Mức độ chuyên sâu thực tế của tài liệu (0=quá cơ bản, 100=rất chuyên sâu)
  "suitableForFocus": true/false,      // [Tham khảo] Tài liệu có thể khai thác theo hướng "${focusLabel}" không?
  "suitableForDepth": true/false,      // [Tham khảo] Tài liệu có nội dung ở mức "${depthLabel}" không?
  "focusAdvisory": "...",              // Gợi ý cách khai thác tài liệu theo phong cách học (1-2 câu)
  "depthAdvisory": "...",              // Gợi ý điều chỉnh nếu độ sâu không khớp (1-2 câu, để trống nếu khớp)
  "warnings": ["..."],                 // Cảnh báo về chất lượng nội dung (không phải về chủ đề)
  "recommendation": "proceed|warn|reject",  // proceed=OK, warn=cảnh báo nhẹ, reject=nội dung rác/rỗng hoàn toàn
  "recommendationReason": "..."        // Lý do ngắn gọn (nếu warn/reject)
}`;

  try {
    const raw = await safeGroq(
      [{ role: "user", content: prompt }],
      MODEL_SMART,
      900,
      true
    );

    const parsed = JSON.parse(raw);
    return {
      isTeachable: Boolean(parsed.isTeachable),
      hasAccuracyConcerns: Boolean(parsed.hasAccuracyConcerns),
      detectedDomain: String(parsed.detectedDomain || "Không xác định"),
      contentQualityScore: Number(parsed.contentQualityScore) || 50,
      depthScore: Number(parsed.depthScore) || 50,
      // Advisory only — không dùng để block
      suitableForFocus: Boolean(parsed.suitableForFocus !== false), // default true
      suitableForDepth: Boolean(parsed.suitableForDepth !== false), // default true
      focusAdvisory: String(parsed.focusAdvisory || ""),
      depthAdvisory: String(parsed.depthAdvisory || ""),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      recommendation: parsed.recommendation || "proceed",
      recommendationReason: String(parsed.recommendationReason || ""),
    };
  } catch (err) {
    console.warn("[docValidation] AI accuracy check failed:", err.message);
    return {
      isTeachable: true,
      hasAccuracyConcerns: false,
      detectedDomain: "Không xác định",
      contentQualityScore: 60,
      depthScore: 50,
      suitableForFocus: true,
      suitableForDepth: true,
      focusAdvisory: "",
      depthAdvisory: "",
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
 *
 * Trả về ValidationResult:
 * {
 *   passed: boolean,
 *   level: "ok"|"warn"|"error",
 *   metrics: { words, docType, ... },
 *   aiResult: { ... },
 *   issues: string[],            // chỉ vấn đề thực sự (lỗi/cảnh báo chất lượng)
 *   advisories: string[],        // gợi ý về focus/depth (không phải lỗi)
 *   depthGapWarning: string|null
 * }
 *
 * NGUYÊN TẮC BLOCKING (level="error", passed=false):
 *   - Tài liệu quá ngắn (< 150 từ)
 *   - Tỉ lệ ký tự rác thực sự cao (sau khi đã điều chỉnh theo loại tài liệu)
 *   - AI đánh giá isTeachable=false
 *   - contentQualityScore < 30
 *   - AI recommendation="reject"
 *
 * KHÔNG BLOCKING (chỉ warning/advisory):
 *   - suitableForFocus=false hoặc suitableForDepth=false → chỉ là gợi ý
 *   - depthScore thấp/cao hơn mong đợi → depthGapWarning
 */
const validateDocument = async (text, { focus = "theory", depth = "basic" } = {}) => {
  console.log(`[docValidation] Bắt đầu validation: focus=${focus}, depth=${depth}`);

  const issues = [];      // Vấn đề thực sự (ảnh hưởng đến level)
  const advisories = [];  // Gợi ý tham khảo (không ảnh hưởng level)
  let level = "ok";

  // ── 1. Basic metrics ──────────────────────────────────────────────────────
  const metrics = getBasicMetrics(text);
  console.log("[docValidation] Metrics:", metrics);

  // Kiểm tra độ dài
  if (metrics.words < 150) {
    issues.push(`Tài liệu quá ngắn (${metrics.words} từ). Cần tối thiểu 150 từ để tạo lộ trình.`);
    level = "error";
  } else if (metrics.words < 400) {
    issues.push(`Tài liệu khá ngắn (${metrics.words} từ). Nội dung bài học có thể không đủ chi tiết.`);
    level = "warn";
  }

  // Kiểm tra tỉ lệ ký tự — ngưỡng điều chỉnh theo loại tài liệu
  // Technical docs (SQL, code): ngưỡng thấp hơn vì ký tự đặc biệt là bình thường
  const junkThreshold = metrics.docType === "technical" ? 0.20 : 0.40;
  if (metrics.meaningfulRatio < junkThreshold) {
    issues.push(
      `Tài liệu chứa nhiều ký tự không nhận dạng được (${Math.round((1 - metrics.meaningfulRatio) * 100)}%). ` +
      `Có thể trích xuất PDF bị lỗi hoặc file bị hỏng.`
    );
    level = level === "ok" ? "warn" : level;
  }

  // Kiểm tra câu hoàn chỉnh — technical dùng "lines" thay "sentences"
  const sentenceThreshold = metrics.docType === "technical" ? 3 : 5;
  if (metrics.sentences < sentenceThreshold) {
    issues.push("Tài liệu không có đủ nội dung đọc được — có thể chỉ là tiêu đề hoặc bảng trống.");
    level = level === "ok" ? "warn" : level;
  }

  // ── 2. AI validation ──────────────────────────────────────────────────────
  let aiResult = null;

  if (level !== "error") {
    aiResult = await verifyContentAccuracy(text, focus, depth);

    // --- BLOCKING checks (chỉ về chất lượng nội dung, không về chủ đề) ---

    if (!aiResult.isTeachable) {
      issues.push("AI đánh giá: Tài liệu không có đủ nội dung học thuật để giảng dạy.");
      level = "error";
    }

    if (aiResult.hasAccuracyConcerns) {
      issues.push("AI phát hiện dấu hiệu nội dung có thể không chính xác hoặc mâu thuẫn nội bộ.");
      level = level === "ok" ? "warn" : level;
    }

    if (aiResult.contentQualityScore < 30) {
      issues.push(
        `Điểm chất lượng nội dung thấp (${aiResult.contentQualityScore}/100). ` +
        `Nội dung có thể là rác hoặc không có giá trị học thuật.`
      );
      level = "error";
    } else if (aiResult.contentQualityScore < 55) {
      issues.push(
        `Chất lượng nội dung ở mức trung bình (${aiResult.contentQualityScore}/100). ` +
        `Bài học có thể thiếu chi tiết.`
      );
      level = level === "ok" ? "warn" : level;
    }

    if (aiResult.recommendation === "reject") {
      level = "error";
      if (aiResult.recommendationReason) {
        issues.push(`AI khuyến nghị từ chối: ${aiResult.recommendationReason}`);
      }
    } else if (aiResult.recommendation === "warn") {
      level = level === "ok" ? "warn" : level;
      if (aiResult.recommendationReason) {
        issues.push(aiResult.recommendationReason);
      }
    }

    // Cảnh báo từ AI về chất lượng nội dung
    if (Array.isArray(aiResult.warnings)) {
      aiResult.warnings.forEach(w => {
        if (w && !issues.includes(w)) issues.push(w);
      });
    }

    // --- ADVISORY checks (về focus/depth — không ảnh hưởng level) ---
    // Đây là GỢI Ý cho người dùng, không phải lỗi

    if (aiResult.focusAdvisory) {
      advisories.push(aiResult.focusAdvisory);
    }

    if (!aiResult.suitableForFocus && aiResult.detectedDomain !== "Không xác định") {
      advisories.push(
        `Tài liệu về "${aiResult.detectedDomain}" — ` +
        `bạn có thể điều chỉnh cách học để phù hợp với phong cách "${focus === "practice" ? "Thực hành" : "Lý thuyết"}".`
      );
    }
  }

  // ── 3. Depth gap check (advisory only) ───────────────────────────────────
  let depthGapWarning = null;
  if (aiResult) {
    const docDepth = aiResult.depthScore;

    if (depth === "deep" && docDepth < 45) {
      depthGapWarning =
        `Tài liệu có mức độ chuyên sâu thực tế thấp (${docDepth}/100) so với mục tiêu "Chuyên sâu". ` +
        `Bài học có thể không đạt độ sâu mong muốn — cân nhắc bổ sung tài liệu nâng cao.`;
      level = level === "ok" ? "warn" : level;

    } else if (depth === "basic" && docDepth > 80) {
      depthGapWarning =
        `Tài liệu có nội dung khá chuyên sâu (${docDepth}/100) so với mục tiêu "Cơ bản". ` +
        `Bạn có thể chuyển sang mục tiêu "Chuyên sâu" để tận dụng tốt hơn — ` +
        `hoặc giữ nguyên để hệ thống tự lọc phần phù hợp.`;
      // Không phải lỗi, chỉ gợi ý → không thay đổi level
    }

    // Nếu AI có gợi ý riêng về depth thì thêm vào advisories
    if (aiResult.depthAdvisory && !depthGapWarning) {
      advisories.push(aiResult.depthAdvisory);
    }
  }

  const passed = level !== "error";

  console.log(
    `[docValidation] Kết quả: level=${level}, passed=${passed}, ` +
    `issues=${issues.length}, advisories=${advisories.length}, ` +
    `docType=${metrics.docType}, domain=${aiResult?.detectedDomain || "?"}`
  );

  return {
    passed,
    level,
    metrics,
    aiResult,
    issues,
    advisories,      // ← MỚI: tách riêng gợi ý focus/depth
    depthGapWarning,
  };
};

module.exports = { validateDocument, getBasicMetrics, verifyContentAccuracy, detectDocumentType };