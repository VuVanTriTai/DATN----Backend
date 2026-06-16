// =========================================================================
// 🧠 FILE: src/services/planService.js - DỊCH VỤ AI SINH BÀI GIẢNG (PLAN SERVICE)
//
// Đây là file QUAN TRỌNG NHẤT của toàn bộ dự án.
// Tác dụng: Chứa toàn bộ logic AI để tạo ra khóa học từ tài liệu.
//
// Các hàm xuất khẩu chính (xuất ra ngoài dùng trong controller):
// ┌─ processAndStoreDocument(planId, text)
// │    Chuội: cleanText → chunkText → generateEmbedding → lưu Chunk vào DB
// │    Mục đích: Chuẩn bị dữ liệu RAG để tìm kiếm sau này
// ├─ generateSyllabus(rawText, numDays, learningGoals)
// │    Chuội: phân tích outline → gọi AI → trả về mảng [{dayNumber, title, objective, coveredSections}]
// ├─ generateScientificLesson(planId, item, userId, ...)
// │    Chuội: HyDE → Vector Search (RAG) → generateLessonContent → generateLessonMeta
// │    Mục đích: Sinh 1 bài giảng đầy đủ có context chính xác từ tài liệu
// └─ analyzeDocument(text, learningGoals, days, metadata)
//      Chuội: gọi AI phân tích nhanh → trả về previewPlan để user xác nhận trước khi tạo
// =========================================================================
// planService.js — FIXED VERSION
"use strict";

const fs = require("fs");
const path = require("path");

const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────
// SERVICES
// ─────────────────────────────
const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks, searchChunksBySection } = require("./vectorSearchService");
const { getLearningMode } = require("./userContextService");
const { generateLessonMeta } = require('./aiService'); // Hoặc đường dẫn tương ứng
const { validateDocument } = require('./docValidationService');
// ─────────────────────────────
// MODELS
// ─────────────────────────────
const Chunk = require("../models/Chunk");

// ─────────────────────────────
// TEXT PROCESSING
// ─────────────────────────────
const { cleanText } = require("../utils/cleanText");

// ✅ LUÔN GIỮ fallback (QUAN TRỌNG)
const { chunkText, mergeBrokenNumberedHeadings, splitIntoPropositions } = require("../utils/chunkText");
const { classifyChunks } = require("../utils/topicClassifier");
const { extractConcepts, mergeConcepts, buildUsedConceptsBlock } = require("../utils/conceptExtractor");



// ─────────────────────────────────────────────
// GLOBAL CONSTANTS (REQUIRED)
// ─────────────────────────────────────────────
const DAYS_MIN = 1;
const DAYS_MAX = 14;
const MAX_ANALYZE_TEXT = 3500;  // ↓ giảm từ 5000 → 3500 để tiết kiệm token
const MODEL_FAST = "llama-3.1-8b-instant";



// AI FEATURES (OPTIONAL SAFE LOAD)
// ─────────────────────────────
let aiChunkText;
let detectMissingContent;

try {
  // ✅ FIX: đường dẫn đúng — aiChunkService.js không tồn tại
  ({ aiChunkText } = require("../utils/aiChunker"));
} catch (_) {
  aiChunkText = async () => [];
}

try {
  ({ detectMissingContent } = require("./missingContentService"));
} catch (_) {
  detectMissingContent = async () => null;
}

// ─────────────────────────────
// CONSTANTS
// ─────────────────────────────
// const MODEL_FAST  = "llama-3.1-8b-instant";
const MODEL_SMART = "llama-3.3-70b-versatile";

// ━━ MODEL FALLBACK CHAIN (theo thứ tự ưu tiên) ━━
// Khi model đầu bị TPD/RPM limit → tự động chuyển sang model kế tiếp
const GROQ_MODEL_CHAIN = [
  "llama-3.1-8b-instant",   // Nhanh nhất, tiêu ít token nhất
  "llama3-8b-8192",         // Fallback 1: llama3 cũ hơn, quota riêng
  "mixtral-8x7b-32768",     // Fallback 2: chất lượng tốt, hỗ trợ JSON mode
  "llama-3.3-70b-versatile",// Fallback 3: mạnh nhất, dùng khi tất cả fast model đều hết
];

// Models hỗ trợ response_format: { type: 'json_object' }
// gemma2-9b-it KHÔNG nằm trong list này vì không hỗ trợ JSON mode
const GROQ_JSON_MODELS = new Set([
  "llama-3.1-8b-instant",
  "llama-3.1-70b-versatile",
  "llama-3.3-70b-versatile",
  "llama3-8b-8192",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
]);

const MAX_CONTEXT_CHARS = 9500;
const MAX_SYLLABUS_TEXT = 7000;  // ↓ giảm từ 10000 → 7000 để tiết kiệm token

//const MAX_ANALYZE_TEXT   = 5000;

const CHUNK_SEARCH_K = 10;  // ✅ FIX: tăng để tìm nhiều chunk hơn
const CHUNK_USE_K = 6;   // ✅ FIX: tăng để có nhiều context hơn, tránh mất ví dụ
const CHUNK_SCORE_THRESHOLD = 0.30; // ✅ FIX: giảm ngưỡng để giữ lại chunk có code



// 🔥 chunk control (quan trọng cho RAG)
const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_WORDS = 40;

// ─────────────────────────────
// LESSON BUDGET
// ─────────────────────────────
// Dùng MODEL_SMART (70b) cho tất cả budget:
// 1. Tài liệu học thuật/khoa học cần reasoning sâu
// 2. Prompt ~7000 tokens → 8b model (8192 ctx limit) không còn đủ buffer cho output
// 3. Token budget bị giới hạn chặt (1800-2600) nên chi phí 70b vẫn chấp nhận được
const LESSON_BUDGET_SHORT  = { contentTokens: 2600, metaTokens: 1800, targetWords: "500-700", useSmarter: true };
const LESSON_BUDGET_MEDIUM = { contentTokens: 2400, metaTokens: 1800, targetWords: "380-540", useSmarter: true };
const LESSON_BUDGET_NORMAL = { contentTokens: 2200, metaTokens: 1800, targetWords: "300-460", useSmarter: true };

const getDynamicLessonBudget = (totalDays) => {
  if (totalDays <= 3) return LESSON_BUDGET_SHORT;
  if (totalDays <= 6) return LESSON_BUDGET_MEDIUM;
  return LESSON_BUDGET_NORMAL;
};

const HARD_CAP_FAST = 1800;
const HARD_CAP_SMART = 2800;

// ─────────────────────────────
// BLOOM TAXONOMY
// ─────────────────────────────
const BLOOM_LEVELS = [
  { label: "Remember", vi: "Nhận biết & ghi nhớ" },
  { label: "Understand", vi: "Hiểu & diễn giải" },
  { label: "Apply", vi: "Vận dụng & thực hành" },
  { label: "Analyze", vi: "Phân tích & so sánh" },
  { label: "Evaluate", vi: "Đánh giá & tổng hợp" },
  { label: "Create", vi: "Sáng tạo & mở rộng" },
];

// ─────────────────────────────
// LEARNING CONFIG
// ─────────────────────────────
const {
  normalizeLearningGoals,
  getQuizBounds,
  getLessonMaxTokens,
  getCompactRetryMaxTokens,
  analyzeContextBlock,
  syllabusBiasInstructions,
  lessonStyleInstructions,
  quizInstructions,
  quizQualityRules,
} = require("../constants/learningGoals");

// ─────────────────────────────────────────────
// REGEX PATTERNS
// ─────────────────────────────────────────────

const META_DISTRACTOR_RE =
  /khong xuat hien trong tai lieu|suy doan ngoai ngu canh|Ket luan trai voi y chinh trong bai hoc/i;
const VERDICT_PREFIX_RE =
  /^(dung\s+theo\s+(bai\s+hoc|bai|tai\s+lieu)\s*[::\s*|sai\s*[::]\s*|correct\s*[::]\s*|wrong\s*[::]\s*|dap\s*an\s*dung\s*[::]\s*|phuong\s*an\s*dung\s*[::]\s*)/i;
const GENERIC_FALLBACK_DISTRACTOR_RE =
  /bo qua dieu kien|gioi han da neu|khong khop phan da hoc|khong can xem xet cac gia dinh|hoan toan thay the cho nhau|loai tru hoan toan moi phu thuoc|hoan doi vai tro trong cung mot co che|bo qua cac rang buoc hoac dieu kien bien|doc lap tuyet doi voi moi phan truoc/i;
const HEURISTIC_QUIZ_BOILERPLATE_RE =
  /hoan doi vai tro trong cung mot co che|bo qua cac rang buoc hoac dieu kien bien|doc lap tuyet doi voi moi phan truoc/i;
const QUIZ_PLACEHOLDER_RE = /(^|\s)---(\s|$)|^\s*\.\.\.\s*$|___+|placeholder/i;
const BOILERPLATE_DISTRACTOR_RE =
  /hoan doi vai tro trong cung mot co che|bo qua cac rang buoc hoac dieu kien bien|doc lap tuyet doi voi moi phan truoc|khong khop phan da hoc|hoan toan thay the cho nhau/i;

// ─────────────────────────────────────────────
// SLEEP & RETRY
// ─────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Trích thời gian chờ từ message Groq: "try again in 6m40.032s" → ms
const parse429WaitMs = (errMsg) => {
  try {
    const full = errMsg.match(/try again in\s+((?:\d+m)?\s*(?:[\d.]+s)?)/i)?.[1] || '';
    let ms = 0;
    const m = full.match(/(\d+)m/); if (m) ms += parseInt(m[1]) * 60000;
    const s = full.match(/([\d.]+)s/); if (s) ms += parseFloat(s[1]) * 1000;
    return ms > 0 ? ms + 2000 : 0;
  } catch { return 0; }
};

const callGroqWithFallback = async (buildParams, startModel = MODEL_FAST) => {
  const chainStart = GROQ_MODEL_CHAIN.indexOf(startModel);
  const modelChain = chainStart >= 0
    ? GROQ_MODEL_CHAIN.slice(chainStart)
    : [startModel, ...GROQ_MODEL_CHAIN];

  let lastErr;

  for (let mi = 0; mi < modelChain.length; mi++) {
    const activeModel = modelChain[mi];
    if (mi > 0) {
      console.warn(`[Groq] "${modelChain[mi - 1]}" bị limit → chuyển ngay sang "${activeModel}"`);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const params = buildParams(activeModel, attempt);
        const res = await groq.chat.completions.create(params);
        const content = res?.choices?.[0]?.message?.content;
        if (!content || typeof content !== 'string') throw new Error('Empty Groq response');
        return content;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || '');
        const status = err?.status || err?.response?.status || 0;
        const is429 = /429|rate_limit/i.test(msg) || status === 429;
        const isTPD = /tokens per day|tpd/i.test(msg);
        const isRPM = /tokens per minute|rpm|requests per minute/i.test(msg);
        const isModelCapErr = /response_format|not support|unsupported|does not support/i.test(msg)
          || status === 400;

        if (isTPD) {
          console.error(`[Groq] ${activeModel} hết TPD (Tokens Per Day). Vui lòng thử lại sau.`);
          break;
        }

        if (isModelCapErr) {
          console.warn(`[Groq] "${activeModel}" không hỗ trợ tính năng → thử model tiếp`);
          break;
        }

        if (isRPM && attempt < 2) {
          const wait = 15000 * (attempt + 1);
          console.warn(`[Groq] "${activeModel}" RPM limit. Đợi ${wait / 1000}s...`);
          await sleep(wait);
          continue;
        }

        if (/timeout|json|parse|empty/i.test(msg) && attempt < 2) {
          await sleep(2000 + 1000 * attempt);
          continue;
        }

        if (is429 && !isTPD && !isRPM && attempt < 1) {
          await sleep(5000);
          continue;
        }

        // Lỗi 4xx không xác định → thử model tiếp
        if (!is429 && !/timeout|json|parse|empty/i.test(msg) && status >= 400) {
          console.warn(`[Groq] "${activeModel}" lỗi ${status}: ${msg.slice(0, 80)} → thử model tiếp`);
          break;
        }

        break;
      }
    }
  }

  console.error('[Groq] Toàn bộ model chain đều thất bại');
  throw lastErr;
};

// Giữ lại retryWithBackoff cho các caller khác (embedding, v.v.)

const retryWithBackoff = async (fn, maxRetries = 3) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const msg = String(err?.message || '');
      const isRetryable = /429|rate|timeout|json|parse/i.test(msg);
      if (!isRetryable || attempt === maxRetries - 1) throw err;
      const delay = 1500 + 500 * Math.pow(2, attempt);
      console.warn(`[Retry] attempt ${attempt + 1} after ${delay}ms`);
      await sleep(delay);
    }
  }
};


///////////////////////////////////////////////////////


// ─────────────────────────────────────────────
// GROQ HELPERS (PRODUCTION SAFE)
// ─────────────────────────────────────────────

const makeGroqRequest = async ({
  messages,
  model = MODEL_FAST,
  temperature = 0.3,
  maxTokens = 2048,
  enforceJSON = true
}) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Invalid messages for Groq');
  }

  return callGroqWithFallback((activeModel, attempt) => {
    const hardCap = activeModel.includes('70b') ? HARD_CAP_SMART : HARD_CAP_FAST;
    const jsonBuf = enforceJSON ? 200 : 0;
    const safeMax = Math.max(256, Math.min(maxTokens - jsonBuf, hardCap) - attempt * 100);
    // Chỉ dùng response_format nếu model hỗ trợ JSON mode
    const supportsJsonMode = GROQ_JSON_MODELS.has(activeModel);
    return {
      messages,
      model: activeModel,
      temperature,
      max_tokens: safeMax,
      ...(enforceJSON && supportsJsonMode ? { response_format: { type: 'json_object' } } : {})
    };
  }, model);
};




const makeGroqPlainRequest = async ({
  messages,
  model = MODEL_FAST,
  temperature = 0.1,
  maxTokens = 1800
}) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Invalid messages for Groq');
  }

  return callGroqWithFallback((activeModel, attempt) => {
    const hardCap = activeModel.includes('70b') ? HARD_CAP_SMART : HARD_CAP_FAST;
    const safeMax = Math.max(256, Math.min(maxTokens, hardCap) - attempt * 100);
    return { messages, model: activeModel, temperature, max_tokens: safeMax };
  }, model);
};


// ─────────────────────────────────────────────
// CORE UTILITIES (SAFE VERSION)
// ─────────────────────────────────────────────

const safeJSONParse = (text) => {
  if (!text || typeof text !== "string") {
    throw new Error("Empty AI response");
  }

  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // Extract JSON block nếu bị lẫn text
  const fb = cleaned.indexOf("{");
  const lb = cleaned.lastIndexOf("}");

  if (fb !== -1 && lb > fb) {
    cleaned = cleaned.slice(fb, lb + 1);
  }

  // Try parse lần 1
  try {
    return JSON.parse(cleaned);
  } catch (e1) { }

  // Fix lỗi comma / newline
  try {
    const fixed = cleaned
      .replace(/("\w+"\s*:\s*"[^"]*")\s*\n\s*"/g, '$1,\n"')
      .replace(/("\w+"\s*:\s*\d+)\s*\n\s*"/g, '$1,\n"')
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");

    return JSON.parse(fixed);
  } catch (_) { }

  // Extract riêng quiz nếu JSON fail
  try {
    const m = cleaned.match(/"quiz"\s*:\s*\[(.*?)\]/s);
    if (m) {
      return JSON.parse(`{"quiz":[${m[1]}]}`);
    }
  } catch (_) { }

  console.error("❌ JSON parse failed:", cleaned.slice(0, 500));
  throw new Error("Invalid JSON from AI");
};


// ─────────────────────────────
// TEXT HELPERS
// ─────────────────────────────

const normalizeSpace = (s) =>
  String(s || "").replace(/\s+/g, " ").trim();

const normalizeTitle = (t) =>
  String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/day\s*\d+/gi, "")
    .replace(/\d+/g, "")
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const getChunkSignature = (content) =>
  normalizeSpace(content).toLowerCase().slice(0, 180);

const splitSentences = (text) =>
  String(text || "")
    .split(/[.!?]\s+/)
    .map(normalizeSpace)
    .filter((s) => s.length > 20);


/**
 * Làm sạch section name từ chunk — loại bỏ section names là code/OCR rác.
 * Dùng trong processAndStoreDocument() khi lưu chunk.section vào DB.
 *
 * @param {string} section
 * @returns {string}
 */
const sanitizeSectionName = (section) => {
  if (!section || typeof section !== "string") return "";

  const s = section.trim();

  // Section name là code fragment
  if (/\[OUTPUT|OUT\]/i.test(s)) return "";
  if (/^\[/.test(s) && /\]/.test(s) && s.length < 10) return "";
  if (/[{}()\[\]|]/.test(s) && s.length < 30) return "";

  // Section name là số đơn hoặc ký hiệu
  if (/^[\d\s,.;:]+$/.test(s)) return "";

  // Section name quá dài (> 120 ký tự) → có thể là content bị lẫn vào
  if (s.length > 120) return s.slice(0, 120);

  return s;
};


// ─────────────────────────────
// FORMULA DETECTOR (IMPROVED)
// ─────────────────────────────

// FIX A — extractFormulaLikeNotes (thay hàm cũ)
//
// Lỗi cũ: URL fragments, code fragments cắt giữa chừng, OCR rác
// lọt vào importantNotes vì filter quá lỏng.
//
// VD bị lọt:
//   "us/library/ms187928.asp"
//   ", VendorContactLName +"
//   "LEFT(VendorContactFName, 1) +"
//   "/CAST(100 AS decimal"
// ═══════════════════════════════════════════════════════════════════════════
  
const extractFormulaLikeNotes = (text) => {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
 
  const results = [];
 
  for (const line of lines) {
    // ── Bỏ qua dấu phân cách chunk ──────────────────────────────────────
    if (/^[-=─═]{2,}$/.test(line)) continue;
 
    // ── Bỏ qua chunk metadata headers ───────────────────────────────────
    if (/^\[Context:/i.test(line)) continue;
    if (/^\[BẢNG/i.test(line)) continue;
 
    // ── Bỏ qua URL / URL fragment ────────────────────────────────────────
    // VD: "us/library/ms187928.asp", "https://...", "http://..."
    if (/^https?:\/\//i.test(line)) continue;
    if (/^[\w./%-]+\.(asp|php|html?|aspx|jsp)\b/i.test(line)) continue;
    if (/^[\w-]+\/[\w-]+\//.test(line)) continue;           // path fragment: "us/library/..."
 
    // ── Bỏ qua code fragment bị cắt giữa chừng ─────────────────────────
    // Dấu hiệu: bắt đầu bằng dấu phẩy, dấu cộng, dấu chấm phẩy, /
    if (/^[,+;/\\()\[\]{}|]/.test(line)) continue;
 
    // Kết thúc bằng dấu cộng, dấu phẩy (dòng bị cắt giữa chừng)
    if (/[+,]$/.test(line)) continue;
 
    // ── Bỏ qua dòng quá ngắn ────────────────────────────────────────────
    if (line.length < 20) continue;
 
    // ── Bỏ qua dòng chứa ký hiệu template/placeholder ──────────────────
    if (/^\[\^/.test(line)) continue;
    if (/^@</.test(line)) continue;
    if (/^\[,\s*@/.test(line)) continue;
 
    // ── Bỏ qua dòng toàn số / ký hiệu ──────────────────────────────────
    if (/^[\d\s\-./]+$/.test(line)) continue;
 
    // ── Bỏ qua OCR noise: chuỗi không có ký tự chữ đủ dài ──────────────
    const letterCount = (line.match(/[a-zA-ZÀ-ỹ]/g) || []).length;
    if (letterCount < 6) continue;
 
    // ── Bỏ qua dòng bullet bị cắt (◦/• + nội dung < 80 ký tự không có dấu câu) ──
    if (/^[◦•]\s+/.test(line)) {
      const content = line.replace(/^[◦•]\s+/, "").trim();
      if (!/[.!?;:…]$/.test(content) && content.length < 80) continue;
    }
 
    // ── Check nội dung có giá trị học thuật ─────────────────────────────
    const hasMath = /[=+\-*/^√∑∏≤≥≈%]/.test(line);
    const hasDef  = /(định nghĩa|công thức|theorem|lemma|hệ quả|quy tắc|rule|property|axiom)/i.test(line);
 
    // hasMath phải đi kèm chữ thực sự (tránh "-" hay "=" đơn thuần)
    const hasMeaningfulMath = hasMath && /[a-zA-ZÀ-ỹ]{3,}/.test(line);
 
    const tooNoisy = line.length > 250;
 
    if ((hasMeaningfulMath || hasDef) && !tooNoisy) {
      results.push(line.length > 180 ? line.slice(0, 180) + "..." : line);
    }
  }
 
  return [...new Set(results)].slice(0, 8);
};

// ─────────────────────────────────────────────
// ✅ FIX #2: EXTRACT CODE IDENTIFIERS FROM CONTEXT
// Trích xuất tên SP, bảng, biến SQL từ context RAG
// để prompt có thể nhắc AI dùng đúng tên từ tài liệu
// ─────────────────────────────────────────────
const extractCodeIdentifiers = (text) => {
  // ✅ Decode HTML entities trước (PDF parser có thể inject &lt; &gt; &amp;)
  let src = String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "");

  const found = new Set();

  // Stored Procedures / Functions: sp*, fn*, usp*
  const spMatches = src.match(/\b(sp[A-Z][A-Za-z0-9_]+|usp[A-Z][A-Za-z0-9_]+|fn[A-Z][A-Za-z0-9_]+)/g) || [];
  spMatches.forEach(m => found.add(m));

  // CREATE PROC / CREATE PROCEDURE / CREATE FUNCTION tên
  const createMatches = src.match(/CREATE\s+(?:PROC|PROCEDURE|FUNCTION)\s+(\w+)/gi) || [];
  createMatches.forEach(m => {
    const name = m.split(/\s+/).pop();
    if (name && name.length > 2) found.add(name);
  });

  // Tên bảng từ FROM / JOIN / INSERT / UPDATE
  const tableMatches = src.match(/(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([A-Z][A-Za-z0-9_]+)/g) || [];
  tableMatches.forEach(m => {
    const name = m.split(/\s+/).pop();
    if (name && name.length > 2 && !/^(SELECT|WHERE|SET|VALUES|BEGIN|END|TRAN)$/i.test(name)) {
      found.add(name);
    }
  });

  // Tên biến SQL hệ thống (@@TRANCOUNT, @@IDENTITY, @@ROWCOUNT)
  const sysVars = src.match(/@@[A-Z]+/gi) || [];
  sysVars.forEach(m => found.add(m));

  return [...found].slice(0, 15);
};

// ─────────────────────────────
// ✅ FIX: EXTRACT KEY FACTS FROM CONTEXT
// Trích xuất các sự kiện/phân loại quan trọng
// để inject vào prompt bắt buộc AI phải cover đầy đủ
// ─────────────────────────────
const extractKeyFacts = (text) => {
  const src = String(text || "")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, '');
  const facts = [];

  // 1. Các dòng liệt kê có đánh số: "1. ...", "2. ..."
  const numberedLines = src.match(/^\s*\d+[.)\-]\s+.{10,}/gm) || [];
  numberedLines.forEach(l => facts.push(l.trim()));

  // 2. Phân loại (VI): "X loại:", "X trường hợp:", "X nhóm:"
  const classVI = src.match(/.{5,}(?:loại|trường hợp|nhóm|kiểu|dạng|cách|mức|bước)\s*[:]\.?.{5,}/gi) || [];
  classVI.forEach(l => facts.push(l.trim().slice(0, 200)));

  // 2b. Phân loại (EN): "N types of", "N categories", "N steps"
  const classEN = src.match(/.{5,}(?:types? of|categories|methods|steps|phases|stages|levels|forms|kinds)\s*.{5,}/gi) || [];
  classEN.forEach(l => facts.push(l.trim().slice(0, 200)));

  // 3. Định nghĩa (VI): "X là Y", "X được định nghĩa là"
  const defVI = src.match(/.{5,}(?:là một|là tập|là quá trình|được định nghĩa).{10,}/gi) || [];
  defVI.forEach(l => facts.push(l.trim().slice(0, 200)));

  // 3b. Định nghĩa (EN): "X is defined as", "X refers to"
  const defEN = src.match(/.{5,}(?:is defined as|refers to|is a |are the ).{10,}/gi) || [];
  defEN.forEach(l => facts.push(l.trim().slice(0, 200)));

  // 4. Bullet points quan trọng
  const bullets = src.match(/^\s*[◦•*\-] {1,}[A-ZÀ-ỹ].{15,}/gm) || [];
  bullets.slice(0, 8).forEach(l => facts.push(l.trim()));

  // 5. Headings trong context — để AI không bỏ sót section nào
  const headings = src.match(/^#{1,3}\s+.{5,}/gm) || [];
  headings.slice(0, 6).forEach(l => facts.push(l.trim()));

  return [...new Set(facts)]
    .filter(f => f.length >= 15)
    .slice(0, 15);
};

// ─────────────────────────────────────────────────────────
// POST-GENERATION: XÓA CODE BLOCK BỊA
// Quét từng code block trong bài học do AI sinh,
// nếu chứa identifier không có trong CONTEXT → xóa block đó
// ─────────────────────────────────────────────────────────
const T_SQL_KEYWORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'ON', 'SET', 'VALUES', 'BEGIN', 'END', 'TRAN', 'TRANSACTION', 'COMMIT', 'ROLLBACK',
  'CREATE', 'ALTER', 'DROP', 'PROC', 'PROCEDURE', 'FUNCTION', 'TABLE', 'IF', 'ELSE',
  'DECLARE', 'EXEC', 'EXECUTE', 'RETURN', 'PRINT', 'CONVERT', 'CAST', 'NULL', 'NOT',
  'AND', 'OR', 'AS', 'INTO', 'WITH', 'RECOMPILE', 'ENCRYPTION', 'OUTPUT', 'OUT',
  'COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'IDENTITY', 'TRANCOUNT', 'ROWCOUNT', 'SAVE',
  'LIKE', 'IN', 'EXISTS', 'DISTINCT', 'TOP', 'ORDER', 'BY', 'GROUP', 'HAVING',
  'RAISERROR', 'TRY', 'CATCH', 'THROW', 'GO', 'USE', 'INT', 'VARCHAR', 'MONEY',
  'DATETIME', 'SMALLDATETIME', 'BIT', 'FLOAT', 'NVARCHAR', 'DATE', 'PRIMARY', 'KEY',
  'RETURNS', 'SCOPE_IDENTITY', 'GETDATE', 'PRINT', 'CONVERT', 'OBJECT_ID',
  'INVOICES', 'VENDORS', 'INVOICELINEITEMS', 'INVOICECOPY', 'VENDORCOPY',
]);

// ✅ FIX: Whitelist keywords ngôn ngữ lập trình phổ biến — tránh false-positive với Python/R/Java/pseudocode
const PROGRAMMING_KEYWORDS = new Set([
  'DEF', 'CLASS', 'IMPORT', 'RETURN', 'SELF', 'NONE', 'TRUE', 'FALSE',
  'ELIF', 'FOR', 'WHILE', 'WITH', 'LAMBDA', 'YIELD', 'RAISE', 'EXCEPT', 'FINALLY', 'PASS',
  'BREAK', 'CONTINUE', 'GLOBAL', 'NONLOCAL', 'ASSERT', 'SUPER', 'INIT',
  'APPEND', 'EXTEND', 'ITEMS', 'KEYS', 'ENUMERATE', 'ZIP', 'MAP', 'FILTER', 'LEN', 'RANGE',
  'LIBRARY', 'REQUIRE', 'NA', 'NAN', 'FRAME', 'VECTOR',  // R
  'PUBLIC', 'PRIVATE', 'PROTECTED', 'STATIC', 'VOID', 'NEW', 'THIS', 'EXTENDS',
  'IMPLEMENTS', 'INTERFACE', 'ABSTRACT', 'FINAL', 'OVERRIDE', 'THROWS', 'STRING', 'BOOLEAN', 'DOUBLE',
  'ALGORITHM', 'INPUT', 'OUTPUT', 'REPEAT', 'UNTIL', 'NODE', 'GRAPH', 'TREE',
  'QUEUE', 'STACK', 'HEAP', 'SORT', 'SEARCH', 'THEN', 'DO', 'EACH', 'LET', 'VAR', 'CONST',
  'STEP', 'MOD', 'DIV', 'ARRAY', 'PROCEDURE', 'BEGIN',
]);

// ✅ FIX: Chỉ apply CodeGuard với SQL context — tài liệu học thuật không có pattern này
const isSqlContext = (contextText) =>
  /\b(CREATE\s+(PROC|PROCEDURE|FUNCTION|TABLE)|DECLARE\s+@|@@[A-Z]+|BEGIN\s+TRAN|RAISERROR|EXEC\s+\w)/i.test(
    contextText || ""
  );

const stripInvalidCodeBlocks = (content, contextText) => {
  if (!content || !contextText) return content;

  // ✅ FIX: Bỏ qua hoàn toàn với tài liệu không phải SQL.
  // Chủ đề chính là học thuật/khoa học → không có pattern CREATE PROC / DECLARE @
  if (!isSqlContext(contextText)) {
    return content;
  }

  // Decode HTML entities trong context trước khi so sánh
  const safeCtx = contextText
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .toLowerCase();

  const CODE_BLOCK_RE = /```[\w]*\n([\s\S]*?)```/g;
  let result = content;
  let match;
  const toRemove = [];

  while ((match = CODE_BLOCK_RE.exec(content)) !== null) {
    const blockFull = match[0];
    const blockCode = match[1];

    const identifiers = [];

    // @param names
    (blockCode.match(/@[A-Za-z][A-Za-z0-9_]*/g) || []).forEach(v => identifiers.push(v));

    // SP names: sp*, usp*, fn*
    (blockCode.match(/\b(sp[A-Z][A-Za-z0-9_]+|usp[A-Z][A-Za-z0-9_]+|fn[A-Z][A-Za-z0-9_]+)/g) || [])
      .forEach(v => identifiers.push(v));

    // Tên bảng / hàm sau keyword
    (blockCode.match(/(?:from|join|into|update|table|procedure|proc|function)\s+([A-Za-z#][A-Za-z0-9_]*)/gi) || [])
      .forEach(m => identifiers.push(m.trim().split(/\s+/).pop()));

    // ✅ FIX: Lọc bỏ T-SQL keywords và programming keywords phổ biến (Python/R/Java/pseudocode)
    const nonKeywordIds = identifiers.filter(id =>
      !T_SQL_KEYWORDS.has(id.replace(/^@/, '').toUpperCase()) &&
      !PROGRAMMING_KEYWORDS.has(id.replace(/^@/, '').toUpperCase()) &&
      id.length > 2
    );

    if (nonKeywordIds.length === 0) continue; // chỉ có keywords → giữ lại

    // Kiểm tra từng identifier có trong context không
    const fakeIds = nonKeywordIds.filter(id => {
      const clean = id.replace(/^@/, '').toLowerCase();
      if (safeCtx.includes(clean)) return false;           // có trong context → ok
      if (id.startsWith('@') && clean.length <= 3) return false; // @p1, @n... → bỏ qua
      return true;
    });

    // ✅ FIX: Tăng threshold lên 3 (từ 2) — giảm false-positive với SQL phức tạp
    // và tài liệu dùng hỗn hợp nhiều ngôn ngữ lập trình
    if (fakeIds.length >= 3) {
      console.warn(`[CodeGuard] Xóa code block chứa identifier bịa: ${fakeIds.join(', ')}`);
      toRemove.push({ full: blockFull, fakes: fakeIds });
    } else if (fakeIds.length >= 1) {
      console.log(`[CodeGuard] Bỏ qua cảnh báo: "${fakeIds.join(', ')}" không thấy trong chunk hiện tại (có thể ở chunk khác)`);
    }
  }

  // Thay code block bịa bằng ghi chú cảnh báo
  for (const { full, fakes } of toRemove) {
    const note = `> ⚠️ *Ví dụ code bị lược bỏ vì chứa tên không có trong tài liệu: \`${fakes.join('`, `')}\`*`;
    result = result.replace(full, note);
  }

  return result;
};

// ─────────────────────────────
// LEARNING LOGIC
// ─────────────────────────────

const getBloomLevel = (dayIndex, totalDays) => {
  const ratio = dayIndex / Math.max(1, totalDays - 1);
  const idx = Math.min(
    BLOOM_LEVELS.length - 1,
    Math.floor(ratio * BLOOM_LEVELS.length)
  );
  return BLOOM_LEVELS[idx];
};


const getObjectiveSeedsFromText = (text, days) => {
  const sentences = splitSentences(text);

  if (!sentences.length) {
    return Array.from({ length: days }, () => "");
  }

  return Array.from({ length: days }, (_, i) => {
    const idx = Math.floor((i * sentences.length) / Math.max(1, days));
    return (sentences[idx] || "").slice(0, 150);
  });
};


// ─────────────────────────────
// DOCUMENT OUTLINE (IMPROVED)
// ─────────────────────────────

const extractDocumentOutline = (text) => {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const headings = [];

  for (const line of lines) {
    // Markdown heading
    const md = line.match(/^(#{1,3})\s+(.+)/);
    if (md) {
      headings.push(md[2].replace(/[*_`]/g, "").slice(0, 100));
      continue;
    }

    // Numbered sections
    const num = line.match(/^(\d+(\.\d+)*)\s+(.{3,80})/);
    if (num) {
      headings.push(`${num[1]} ${num[3]}`.slice(0, 100));
      continue;
    }

    // Chapter keywords
    if (/^(chương|chapter|phần|section)\s+/i.test(line)) {
      headings.push(line.slice(0, 100));
    }
  }
  // ── CLEAN OCR NOISE ──────────────────────────────────────────
  const cleanHeadings = [...new Set(headings)].filter((h) => {
    // Loại bỏ heading có khoảng trắng bất thường giữa chữ: "Gi ới", "Ki ể u"
    if (/\b\w{1,2}\s+\w{1,2}\s+\w/.test(h)) return false;

    // Loại bỏ heading chứa nội dung bảng/kết quả lẫn vào
    if (/Thao tác|Kết quả|Ki ể u|int\)|50\/100/.test(h)) return false;

    // Loại bỏ heading quá dài (> 80 ký tự sau khi đã slice — thường là content)
    if (h.replace(/^\d+(\.\d+)*\s+/, "").length > 75) return false;

    // Loại bỏ heading có dấu ngoặc đơn lẻ hoặc ký tự code
    if (/[()]{2,}|\)+$/.test(h)) return false;

    return true;
  });

  return [...new Set(headings)].slice(0, 40);
};

// ─────────────────────────────────────────────
// [FIX-2] SCOPE GUARD — hard validation sau generate
// ─────────────────────────────────────────────

/**
 * Kiểm tra content có vi phạm scope không.
 * Trả về { ok, violations[] }
 *
 * Logic:
 * 1. Nếu content đề cập keyword của topic KHÁC (previousSummaries) quá nhiều → violation
 * 2. Nếu coveredSections có nhưng content không có BẤT KỲ keyword nào → warning
 */// ─────────────────────────────────────────────
// SCOPE VALIDATION
// ─────────────────────────────────────────────

const normalizeText = (text) =>
  String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const validateScopeCompliance = (content, item, previousSummaries = []) => {
  const violations = [];
  const contentNorm = normalizeText(content);

  // ── CHECK 1: trùng nội dung ngày trước ──
  for (const prev of previousSummaries) {
    const prevTitleNorm = normalizeText(prev.title);

    const keywords = prevTitleNorm
      .split(/\s+/)
      .filter((w) => w.length > 4);

    if (keywords.length === 0) continue;

    let hitCount = 0;

    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw}\\b`, "g");
      const matches = contentNorm.match(regex);
      if (matches && matches.length >= 2) {
        hitCount++;
      }
    }

    if (hitCount >= 3) {
      violations.push(
        `⚠️ Có dấu hiệu lặp Ngày ${prev.day} ("${prev.title}")`
      );
    }
  }

  // ── CHECK 2: thiếu section ──
  const coveredSections = item?.coveredSections || [];

  if (coveredSections.length > 0) {
    const missingSections = coveredSections.filter((s) => {
      const key = normalizeText(s).substring(0, 30);
      return key.length > 4 && !contentNorm.includes(key);
    });

    if (missingSections.length > 0) {
      violations.push(
        `⚠️ Thiếu nội dung section: ${missingSections.join(", ")}`
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
};

// ─────────────────────────────────────────────
// ANTI-DUP (JACCARD)
// ─────────────────────────────────────────────

const tokenize = (text) => {
  const stopwords = new Set(["trong", "của", "các", "cho", "với", "những", "một", "được", "này", "khi", "thì", "không", "phải", "như", "theo"]);
  return new Set(
    normalizeText(text)
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopwords.has(w))
  );
};

const computeContentOverlap = (textA, textB) => {
  const setA = tokenize(textA);
  const setB = tokenize(textB);

  if (!setA.size || !setB.size) return 0;

  let intersection = 0;

  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  // Jaccard similarity an toàn hơn so với Math.min
  return intersection / (setA.size + setB.size - intersection);
};

const checkContentDuplication = (newContent, previousSummaries = []) => {
  const results = [];

  for (const prev of previousSummaries) {
    const ref = `${prev.title} ${prev.summary || ""}`;

    const ratio = computeContentOverlap(
      newContent.substring(0, 1000),
      ref
    );

    if (ratio > 0.35) {
      results.push({
        day: prev.day,
        title: prev.title,
        ratio: Math.round(ratio * 100),
        severity:
          ratio > 0.65 ? "high" :
            ratio > 0.5 ? "medium" : "low"
      });
    }
  }

  return results;
};

// ─────────────────────────────────────────────
// RAG SCORE FILTER (VERY IMPORTANT)
// ─────────────────────────────────────────────

const filterChunksByScore = (
  chunks = [],
  threshold = CHUNK_SCORE_THRESHOLD,
  minKeep = 2
) => {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const sorted = [...chunks].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0)
  );

  const passing = sorted.filter(
    (c) => (c.score ?? 0) >= threshold
  );

  // Nếu đủ chunk chất lượng → dùng luôn
  if (passing.length >= minKeep) return passing;

  // Nếu không đủ → fallback giữ top-K
  return sorted.slice(0, minKeep);
};
// ─────────────────────────────────────────────
// QUIZ VALIDATION PIPELINE (FIXED)
// ─────────────────────────────────────────────

const stripVerdictFromOption = (text) => {
  let s = normalizeSpace(String(text || "").replace(/^\*+|\*+$/g, ""));

  for (let i = 0; i < 4; i++) {
    const cleaned = s
      .replace(VERDICT_PREFIX_RE, "")
      .replace(/^(sai|dung)\s*(vi|do|boi)\s*/i, "")
      .replace(/^(phuong\s*an\s*(sai|dung))\s*/i, "")
      .trim();

    if (cleaned === s) break;
    s = normalizeSpace(cleaned);
  }

  return normalizeSpace(s.replace(/^\*+\s*|\s*\*+$/g, ""));
};

const optionStillHasVerdictLeak = (o) =>
  /^(dung|sai)\b/i.test(normalizeSpace(o));

// ─────────────────────────────

const countMetaLikeOptions = (q) =>
  (q.options || []).filter((o) =>
    META_DISTRACTOR_RE.test(normalizeSpace(o))
  ).length;

const countBoilerplateDistractors = (q) =>
  (q.options || []).filter((o) =>
    GENERIC_FALLBACK_DISTRACTOR_RE.test(normalizeSpace(o))
  ).length;

// ─────────────────────────────
// SCORING (IMPROVED)
// ─────────────────────────────

const scoreQuizItem = (q) => {
  if (!q?.question || !Array.isArray(q.options) || q.options.length !== 4) {
    return 0;
  }

  let score = 100;

  const question = normalizeSpace(q.question);

  if (QUIZ_PLACEHOLDER_RE.test(question)) return 0;

  // ❌ meta options
  if (countMetaLikeOptions(q) >= 2) score -= 40;

  // ❌ boilerplate
  if (countBoilerplateDistractors(q) >= 1) score -= 30;

  // ❌ verdict leak
  if (q.options.some(optionStillHasVerdictLeak)) score -= 35;

  // ❌ explanation yếu
  if (!q.explanation || q.explanation.length < 20) score -= 20;

  // ❌ correct bị copy từ question
  const correct = normalizeSpace(q.options[q.correctAnswer] || "");
  if (correct && question.includes(correct.slice(0, 40))) {
    score -= 25;
  }

  // ❌ options quá giống nhau (semantic weak)
  const uniqueKeys = new Set(
    q.options.map((o) => normalizeSpace(o).substring(0, 60))
  );
  if (uniqueKeys.size < 4) score -= 30;

  // ❌ độ dài
  const lengths = q.options.map((o) => o.length);
  const avg = lengths.reduce((a, b) => a + b, 0) / 4;
  const variance =
    lengths.reduce((a, b) => a + Math.abs(b - avg), 0) / 4;

  if (avg < 20) score -= 15;
  if (variance < 8) score -= 10;

  return Math.max(0, score);
};

// ─────────────────────────────
// NORMALIZE ITEM (STRICT)
// ─────────────────────────────

const normalizeQuizItem = (q) => {
  if (!q?.question || !Array.isArray(q.options)) return null;

  const question = normalizeSpace(q.question);
  if (QUIZ_PLACEHOLDER_RE.test(question)) return null;

  let options = q.options
    .map(stripVerdictFromOption)
    .map(normalizeSpace)
    .filter(Boolean)
    .slice(0, 4);

  if (options.length !== 4) return null;

  // ❌ option quá ngắn hoặc placeholder
  if (options.some((o) => o.length < 8 || QUIZ_PLACEHOLDER_RE.test(o))) {
    return null;
  }

  // ❌ duplicate option
  const keys = options.map((o) => o.toLowerCase().substring(0, 120));
  if (new Set(keys).size !== 4) return null;

  let correctAnswer = Number(q.correctAnswer);
  if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) {
    correctAnswer = 0;
  }

  const normalized = {
    question,
    options,
    correctAnswer,
    explanation: normalizeSpace(q.explanation || ""),
  };

  normalized._score = scoreQuizItem(normalized);

  return normalized;
};

// ─────────────────────────────
// DEDUPE (IMPROVED)
// ─────────────────────────────

const dedupeQuizByQuestionStem = (quiz) => {
  const seen = new Set();

  return quiz.filter((q) => {
    const key = normalizeSpace(q.question)
      .toLowerCase()
      .substring(0, 120);

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
};

// ─────────────────────────────
// FILTER + RANK
// ─────────────────────────────

const filterAndRankQuiz = (quiz, threshold = 50) => {
  return quiz
    .filter((q) => (q._score ?? scoreQuizItem(q)) >= threshold)
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
};

// ─────────────────────────────
// BATCH QUALITY CHECK
// ─────────────────────────────

const quizBatchLooksLowQuality = (quiz) => {
  if (!Array.isArray(quiz) || quiz.length === 0) return true;

  const avg =
    quiz.reduce((s, q) => s + (q._score ?? scoreQuizItem(q)), 0) /
    quiz.length;

  return avg < 60; // 🔥 tăng độ khó
};

// ─────────────────────────────
// NORMALIZE BATCH
// ─────────────────────────────

const normalizeQuizBatch = (rawQuiz) => {
  const mapped = (Array.isArray(rawQuiz) ? rawQuiz : [])
    .map(normalizeQuizItem)
    .filter(Boolean);

  const deduped = dedupeQuizByQuestionStem(mapped);

  return filterAndRankQuiz(deduped);
};


////111111111111111111111
// ─────────────────────────────────────────────
// LESSON DATA NORMALIZATION
// ─────────────────────────────────────────────

const normalizeLessonData = (
  data,
  fallbackObjective = "",
  fallbackFormulaNotes = [],
  topic = "",
  quizBounds = { min: 3, max: 5 },
  practiceBias = false,
  opts = {}
) => {
  const allowHeuristicFallback = Boolean(opts.allowHeuristicFallback);

  const minQuiz = Math.max(1, quizBounds?.min || 3);
  const maxQuiz = Math.max(minQuiz, quizBounds?.max || 5);

  const safe = (data && typeof data === "object") ? data : {};

  // ── CONTENT ──
  const content = typeof safe.content === "string"
    ? safe.content.trim()
    : "";

  // ── SUMMARY ──
  const summary = typeof safe.summary === "string" && safe.summary.trim()
    ? safe.summary.trim()
    : fallbackObjective || "Tóm tắt nội dung chính.";

  // ── IMPORTANT NOTES ──
  const importantNotesRaw = Array.isArray(safe.importantNotes)
    ? safe.importantNotes
    : [];

  // ✅ FIX: Lọc sạch rác trước khi merge
  const cleanNote = (x) => {
    const s = normalizeSpace(String(x || ""));
    if (!s) return null;

    // Loại bỏ chunk metadata headers: [Context: ...], [BẢNG DỮ LIỆU...]
    if (/^\[Context:/i.test(s)) return null;
    if (/^\[BẢNG/i.test(s)) return null;

    // Loại bỏ dấu phân cách vô nghĩa: ---, --, -, ===, ...
    if (/^[-=─═]{1,}$/.test(s.trim())) return null;

    // Loại bỏ dòng chứa ký hiệu [^] hoặc pattern SQL template placeholder
    if (/^\[\^/.test(s.trim())) return null;
    // Bỏ qua URL fragment
    if (/^https?:\/\//i.test(s)) return null;
    if (/^[\w./%-]+\.(asp|php|html?|aspx)\b/i.test(s)) return null;
    if (/^[\w-]+\/[\w-]+\//.test(s)) return null;
 
    // Bỏ qua code fragment bị cắt (bắt đầu hoặc kết thúc bằng dấu đặc biệt)
    if (/^[,+;/\\()\[\]]/.test(s.trim())) return null;
    if (/[+,]$/.test(s.trim()) && s.length < 80) return null;
 
    // Bỏ qua dòng không có đủ chữ (OCR noise)
    const letters = (s.match(/[a-zA-ZÀ-ỹ]/g) || []).length;
    if (letters < 6) return null;

    if (/^@</.test(s.trim())) return null;   // @<tham số 1> <kiểu dữ liệu>...
    if (/^\[,\s*@/.test(s.trim())) return null; // [, @<tham số 2>...

    // Loại bỏ dòng "=> ..." ngắn không có context đầy đủ (< 30 ký tự sau =>)
    const arrowMatch = s.match(/^=>\s*(.+)/);
    if (arrowMatch && arrowMatch[1].trim().length < 30) return null;

    // Loại bỏ dòng bắt đầu bằng ký tự bullet lẻ (◦, •, ▪) không có nội dung
    if (/^[◦•▪]\s*$/.test(s.trim())) return null;

    // ✅ FIX: Loại bỏ dòng bullet ◦/• bị cắt giữa câu (không kết thúc bằng dấu câu hợp lệ)
    if (/^[◦•]\s+/.test(s)) {
      const content = s.replace(/^[◦•]\s+/, "").trim();
      // Bị cắt giữa câu: không có dấu câu cuối và nội dung < 80 ký tự
      if (!/[.!?;:…]$/.test(content) && content.length < 80) return null;
    }

    // Loại bỏ string quá ngắn (< 10 ký tự)
    if (s.trim().length < 10) return null;

    // Loại bỏ các ký tự đơn lẻ hoặc số đơn
    if (/^[\d\s\-\.]+$/.test(s.trim())) return null;

    return s;
  };


  const importantNotesMerged = [
    ...importantNotesRaw,
    ...(Array.isArray(fallbackFormulaNotes) ? fallbackFormulaNotes : [])
  ]
    .map(cleanNote)
    .filter(Boolean);

  const importantNotes = [...new Set(importantNotesMerged)].slice(0, 12);

  // ── QUIZ ──
  let quiz = normalizeQuizBatch(Array.isArray(safe.quiz) ? safe.quiz : []);

  // ✅ FIX: fallback nếu quiz quá ít hoặc chất lượng kém
  if (allowHeuristicFallback) {
    let guard = 0;

    while (
      (quiz.length < minQuiz || quizBatchLooksLowQuality(quiz)) &&
      guard < 3
    ) {
      const autoQuiz = buildFallbackQuiz(
        topic || "bài học",
        content || summary,
        importantNotes,
        minQuiz,
        practiceBias
      );

      quiz = filterAndRankQuiz(
        dedupeQuizByQuestionStem([...quiz, ...autoQuiz])
      );

      guard++;
    }
  }

  // clamp số lượng
  if (quiz.length > maxQuiz) {
    quiz = quiz.slice(0, maxQuiz);
  }

  return {
    content,
    summary,
    importantNotes,
    quiz,
  };
};

// ─────────────────────────────────────────────
// RAG: CHUNK SELECTION
// ─────────────────────────────────────────────

const selectDiverseChunks = (
  chunks,
  usedSignatures = [],
  topK = CHUNK_USE_K
) => {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  const usedSet = new Set(usedSignatures.map(String));

  const scored = chunks.map((chunk) => {
    const sig = getChunkSignature(chunk.content);
    const prefix = sig.substring(0, 80);

    return {
      chunk,
      sig,
      prefix,
      used: usedSet.has(sig),
      score: chunk.score ?? 0,
    };
  });

  const freshChunks = scored.filter((c) => !c.used);
  const minFreshRequired = Math.ceil(topK / 2);
  const allowUsed = freshChunks.length < minFreshRequired;

  // ✅ FIX: sort stable + ưu tiên score cao
  const candidates = scored.slice().sort((a, b) => {
    if (a.used !== b.used) return a.used ? 1 : -1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  const sigPrefixSeen = new Set();
  const selected = [];

  for (const { chunk, prefix, used } of candidates) {
    if (selected.length >= topK) break;

    if (used && !allowUsed && selected.length < minFreshRequired) continue;

    if (!sigPrefixSeen.has(prefix)) {
      selected.push(chunk);
      sigPrefixSeen.add(prefix);
    }
  }

  // fallback nếu chưa đủ diversity
  if (selected.length < minFreshRequired) {
    for (const { chunk, prefix } of candidates) {
      if (selected.length >= topK) break;

      if (!sigPrefixSeen.has(prefix)) {
        selected.push(chunk);
        sigPrefixSeen.add(prefix);
      }
    }
  }

  return selected;
};

// ─────────────────────────────────────────────
// HyDE (Hypothetical Document Embedding)
// ─────────────────────────────────────────────

const generateHyDE = async (topic, objective) => {
  try {
    const response = await makeGroqPlainRequest({
      messages: [
        {
          role: "user",
          content: `Viết một đoạn mô tả kiến thức chi tiết (4-5 câu) cho chủ đề: "${topic}".
Mục tiêu học: ${objective || topic}.
Đề cập đến: định nghĩa, nguyên lý hoạt động, ứng dụng thực tế.
Chỉ trả về đoạn văn, không giải thích thêm.`,
        },
      ],
      model: MODEL_FAST,
      temperature: 0.3,
      maxTokens: 260,
    });

    return (response && response.trim()) || topic;

  } catch (err) {
    console.warn("⚠️ HyDE failed:", err.message);

    return `Kiến thức chi tiết về "${topic}": ${objective || ""}`;
  }
};// ─────────────────────────────────────────────
// QUIZ PROMPT BUILDERS
// ─────────────────────────────────────────────

const buildConciseQuizPrompt = ({
  context,
  searchTopic,
  objective,
  count,
  avoidQuestions = [],
  formulaNotes = [],
}) => {
  const avoidBlock = (avoidQuestions || [])
    .slice(0, 8)
    .map((q, i) => `${i + 1}. ${String(q).slice(0, 100)}`)
    .join("\n");

  const formulaHint = Array.isArray(formulaNotes) && formulaNotes.length > 0
    ? `\nCONG THUC: ${formulaNotes.slice(0, 4).join("; ")}`
    : "";

  return `Tao dung ${count} cau trac nghiem 4 phuong an de cung co kien thuc tu CONTEXT.

TOPIC: ${searchTopic}
MUC TIEU: ${objective || searchTopic}${formulaHint}

QUY TAC:
- Moi cau chi test 1 y
- 4 phuong an phai tuong duong do dai
- KHONG ghi "Dung:", "Sai:"
- Khong lap lai cau hoi
- Phuong an sai phai hop ly (khong vo ly)

TRANH TRUNG:
${avoidBlock || "Khong co"}

CONTEXT:
${String(context || "").substring(0, 5000)}

Chi tra ve JSON:
{"quiz":[{"question":"?","options":["A","B","C","D"],"correctAnswer":0,"explanation":"..."}]}`;
};

const buildMinimalQuizPrompt = ({ context, searchTopic, count }) => {
  return `Tao ${count} cau hoi trac nghiem 4 phuong an ve "${searchTopic}".

TEXT:
${String(context || "").substring(0, 2200)}

Chi tra ve JSON:
{"quiz":[{"question":"...?","options":["A","B","C","D"],"correctAnswer":0,"explanation":"..."}]}`;
};

// ─────────────────────────────────────────────
// AI QUIZ GENERATION
// ─────────────────────────────────────────────

const generateQuizOnlyGroq = async ({
  context,
  searchTopic,
  objective,
  profile,
  count,
  avoidQuestions = [],
  formulaNotes = [],
  keyFacts = [],
  codeIdentifiers = [],
  useSmarterModel = false,
}) => {
  const c = Math.max(1, Math.min(8, parseInt(count, 10) || 4));
  const model = useSmarterModel ? MODEL_SMART : MODEL_FAST;
  const maxTokens = useSmarterModel ? 2600 : 1500;

  // ── STAGE 1: PROMPT FULL ──
  try {
    const response = await makeGroqRequest({
      messages: [
        { role: "system", content: "Tra ve JSON hop le voi khoa 'quiz'." },
        {
          role: "user",
          content: buildConciseQuizPrompt({
            context,
            searchTopic,
            objective,
            count: c,
            avoidQuestions,
            formulaNotes,
          }),
        },
      ],
      model,
      temperature: 0.25,
      maxTokens,
      enforceJSON: true,
    });

    const parsed = safeJSONParse(response);

    if (Array.isArray(parsed?.quiz) && parsed.quiz.length > 0) {
      return parsed.quiz;
    }
  } catch (err) {
    console.warn("[Quiz Stage1] failed:", err.message);
  }

  // ── STAGE 2: PROMPT SIMPLE ──
  try {
    const response = await makeGroqRequest({
      messages: [
        { role: "system", content: "Chi tra ve JSON hop le." },
        {
          role: "user",
          content: buildMinimalQuizPrompt({
            context,
            searchTopic,
            count: Math.min(c, 3),
          }),
        },
      ],
      model: MODEL_FAST,
      temperature: 0.15,
      maxTokens: 1200,
      enforceJSON: true,
    });

    const parsed = safeJSONParse(response);

    if (Array.isArray(parsed?.quiz)) {
      return parsed.quiz;
    }
  } catch (err) {
    console.warn("[Quiz Stage2] failed:", err.message);
  }

  return [];
};

// ─────────────────────────────────────────────
// QUIZ PIPELINE
// ─────────────────────────────────────────────

const runQuizPipeline = async ({
  existingQuiz = [],
  context,
  searchTopic,
  objective,
  profile,
  quizBounds,
  formulaNotes = [],
}) => {
  let quiz = Array.isArray(existingQuiz) ? [...existingQuiz] : [];

  const getGoodQuiz = () => filterAndRankQuiz(quiz);

  const needMore = () => {
    const g = getGoodQuiz();
    return (
      g.length < (quizBounds?.min || 3) ||
      quizBatchLooksLowQuality(g)
    );
  };

  // ── nếu đã đủ tốt thì return luôn ──
  if (!needMore()) {
    return getGoodQuiz().slice(0, quizBounds.max);
  }

  // ── TIER 1 ──
  try {
    const fresh = await generateQuizOnlyGroq({
      context,
      searchTopic,
      objective,
      profile,
      count: quizBounds.max,
      avoidQuestions: quiz.map((q) => q.question),
      formulaNotes,
      useSmarterModel: false,
    });

    quiz = [...quiz, ...fresh];
  } catch (e) {
    console.warn("[QuizPipeline] Tier1 failed:", e.message);
  }



  let finalQuiz = getGoodQuiz();

  // ── FINAL FALLBACK ──
  if (finalQuiz.length < (quizBounds?.min || 3)) {
    console.warn("⚠️ Quiz vẫn thiếu → dùng fallback generator");

    const fallback = buildFallbackQuiz(
      searchTopic,
      context,
      formulaNotes,
      quizBounds.min,
      false
    );

    finalQuiz = filterAndRankQuiz([
      ...finalQuiz,
      ...fallback,
    ]);
  }

  return finalQuiz.slice(0, quizBounds.max);
};
// ─────────────────────────────────────────────
// TWO-PHASE LESSON HELPERS — FIXED
// ─────────────────────────────────────────────

/**
 * [FIX-6] Phase 1 — nội dung Markdown.
 * THAY ĐỔI so với bản cũ:
 *   - Prompt thêm "FORBIDDEN SECTION LIST" rõ ràng hơn
 *   - Sau khi generate, gọi validateScopeCompliance() và log warning
 *   - Nếu overlap > 65% với bài trước → thử regenerate 1 lần với nhiệt độ thấp hơn
 */
////////////////////////////////////

// ✅ Đặt ở cấp module, trước generateLessonContent
const stripPromptLeakage = (content) => {
  if (!content || typeof content !== "string") return content;

  const PROMPT_MARKERS = [
    /={3,}\s*BÀI TRƯỚC[^=]*={3,}[\s\S]*?={3,}/gi,
    /={3,}\s*CONTEXT[^=]*={3,}[\s\S]*?={3,}/gi,
    /={3,}\s*PHẠM VI[^=]*={3,}/gi,
    /━{3,}[\s\S]*?━{3,}/g,
    /^===== .+ =====$/gm,
    /^={3,}\s*$/gm,
    /^\[Context:.*\]$/gm,
    /^\[BẢNG DỮ LIỆU.*\]$/gm,
    /^• Ngày \d+:.*$/gm,
    /THÔNG TIN BÀI:[\s\S]*?YÊU CẦU OUTPUT:/gi,
    /YÊU CẦU OUTPUT:[\s\S]*/gi,
  ];

  let cleaned = content;
  for (const re of PROMPT_MARKERS) {
    cleaned = cleaned.replace(re, "");
  }

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
};


// ─────────────────────────────────────────────────────────────────────────────
// ✍️ HÀM PHụ: VIẾT NỘI DUNG BÀI GIẢNG (generateLessonContent) — Phase 1
//
// Mục đích: Xây dựng prompt đầy đủ rồi gọi Groq AI viết nội dung Markdown của bài giảng.
//
// Cấu trúc prompt được xây dựng từ nhiều khối (“block”) ghép lại:
//   - scopeBlock       : Phạm vi bắt buộc (chủ đề ngày hôm nay + cấm dạy lại ngày cũ)
//   - safeContext      : Ngữ cảnh trích từ tài liệu gốc qua RAG
//   - conceptMemoryBlock: Danh sách khái niệm đã dạy → AI cấm giải thích lại
//   - codeExampleHint  : Nhắc AI chỉ dùng tên biến/hàm có trong tài liệu
//   - requiredFactsBlock: Yầu cầu AI đề cập đủ số loại/trường hợp như tài liệu gốc
//   - modeInstructions : Phạm vi viết (ngắn/dài, lý thuyết/thực hành)
//
// Bảo vệ chất lượng:
//   - stripInvalidCodeBlocks(): Xóa code block AI bọa có tên hàm/bảng không có trong context
//   - validateScopeCompliance(): Kiểm tra bài viết có lệch chủ đề không
//   - checkContentDuplication(): Kiểm tra trùng lặp ý tưởng với bài cũ (Jaccard similarity)
// ─────────────────────────────────────────────────────────────────────────────
const generateLessonContent = async ({
  searchTopic, bloomLevel, bloomInstruction, objective,
  selectedPersona, profile, context,
  codeIdentifiers,
  keyFacts,
  previousSummaries, dayNumber, totalDays, item,
  usedConcepts,   // ← MỚI: concept memory từ các ngày trước
  contextWeakHint,
}) => {
  const budget = getDynamicLessonBudget(totalDays || 7);
  // Luôn dùng MODEL_SMART: prompt ~7000 tokens + budget output → 8b model (8192 ctx) không đủ
  const contentModel = MODEL_SMART;

  // =========================
  // CONTEXT GUARD (dùng context đã được cắt từ caller, chỉ normalize space)
  // =========================
  const safeContext = String(context || "").replace(/\s+/g, " ").trim();

const previousBlock = previousSummaries?.length
  ? previousSummaries
    .map((p) => `• Ngày ${p.day}: "${p.title}" — ${p.summary || "(chưa có)"}`)
    .join("\n")
  : "Chưa có bài nào trước đó.";

const coveredSections = item?.coveredSections || [];

  
// =========================
// FORBIDDEN + SCOPE
// =========================
const forbiddenTopics = (previousSummaries || [])
  .map((p) => `"${p.title}"`)
  .join(", ");

const scopeBlock = coveredSections.length > 0
  ? `━━━━━━━━━━ PHẠM VI BẮT BUỘC ━━━━━━━━━━
NHIỆM VỤ HÔM NAY (Ngày ${dayNumber}/${totalDays}):
Viết bài giảng về "${searchTopic}" tập trung vào:
${coveredSections.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

CẤM TUYỆT ĐỐI:
- Nội dung ngoài danh sách trên
- Nhắc lại hoặc dạy lại: ${forbiddenTopics || "(chưa có)"}
- Tự suy diễn ngoài CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  : `━━━━━━━━━━ PHẠM VI ━━━━━━━━━━
NHIỆM VỤ HÔM NAY (Ngày ${dayNumber}/${totalDays}):
Viết bài giảng về "${searchTopic}"
MỤC TIÊU: ${objective || "Bám sát nội dung cốt lõi"}
CẤM dạy lại: ${forbiddenTopics || "(chưa có)"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;


// =========================
// CODE EXAMPLE HINT — domain-agnostic
// =========================
const identifiersList = Array.isArray(codeIdentifiers) && codeIdentifiers.length > 0
  ? codeIdentifiers : [];

const codeExampleHint = identifiersList.length > 0
  ? `
⚠️ TÊN KỸ THUẬT XUẤT HIỆN TRONG CONTEXT (chỉ được dùng những tên này):
${identifiersList.join(", ")}

QUY TẮC CODE:
- CHỈ dùng tên/identifier có trong danh sách trên
- KHÔNG bịa tên mới không có trong CONTEXT
- KHÔNG dùng tên placeholder như "tenBang", "myFunction", "example"
- Nếu không chắc tên chính xác → dùng văn xuôi thay vì code
`
  : `
🚫 CONTEXT KHÔNG CÓ VÍ DỤ CODE CỤ THỂ:
- KHÔNG viết code block nếu không có ví dụ trong CONTEXT
- Giải thích bằng văn xuôi và bullet points
`;

// =========================
// REQUIRED FACTS
// =========================
const factsList = Array.isArray(keyFacts) && keyFacts.length > 0 ? keyFacts : [];
const requiredFactsBlock = factsList.length > 0
  ? `
❗ NỘI DUNG BẮT BUỘC PHẢI ĐỀ CẬP (trích từ tài liệu gốc):
- Nếu tài liệu liệt kê N loại/trường hợp → PHẢI viết đủ N loại, không bỏ sót.
${factsList.map((f, i) => `  [${i + 1}] ${f}`).join("\n")}
`
  : "";

// =========================
// CONCEPT MEMORY BLOCK — domain-agnostic
// =========================
const conceptMemoryBlock = (() => {
  const concepts = Array.isArray(usedConcepts) && usedConcepts.length > 0
    ? usedConcepts : [];
  if (!concepts.length) return "";

  const conceptList = buildUsedConceptsBlock(concepts);

  return `
⛔ ĐÃ DẠY Ở CÁC NGÀY TRƯỚC — KHÔNG DẠY LẠI:
${conceptList}

QUY TẮC (VI PHẠM = BÀI BỊ HỦY):
1. KHÔNG định nghĩa lại, giải thích lại bất kỳ khái niệm nào trong danh sách trên.
2. Nếu khái niệm cũ cần nhắc để giải thích bối cảnh → tối đa 1 câu, không giải thích lại từ đầu.
3. Bài hôm nay PHẢI có ít nhất 1 khái niệm MỚI hoàn toàn không có trong danh sách.
4. Trước khi viết mỗi đoạn: kiểm tra "khái niệm này đã dạy chưa?" → nếu rồi → BỎ QUA.
`;
})();

// =========================
// MODE INSTRUCTIONS
// =========================
const isDeep = profile?.depth === "deep";
const isPractice = profile?.focus === "practice";

let modeInstructions;
if (isDeep && isPractice) {
  modeInstructions = `
🎯 CHẾ ĐỘ: THỰC HÀNH CHUYÊN SÂU
- Ưu tiên: bài toán thực tế, phân tích edge case, so sánh giải pháp
- Cấu trúc: Vấn đề → Phân tích → Giải pháp → Trường hợp ngoại lệ
- Từ số: ${budget.targetWords}
- Bắt buộc: ít nhất 1 bài tập tư duy cuối bài`;
} else if (isDeep) {
  modeInstructions = `
🎯 CHẾ ĐỘ: LÝ THUYẾT CHUYÊN SÂU
- Ưu tiên: nguyên lý nền tảng, lý giải tại sao, so sánh khái niệm tương đồng
- Cấu trúc: Định nghĩa → Nguyên lý → Phân tích → So sánh → Ứng dụng
- Từ số: ${budget.targetWords}
- Mỗi section PHẢI có "Tại sao?" hoặc "Khi nào không dùng?"`;
} else if (isPractice) {
  modeInstructions = `
🎯 CHẾ ĐỘ: THỰC HÀNH CƠ BẢN
- Ưu tiên: hướng dẫn từng bước, ví dụ cụ thể, cách áp dụng
- Từ số: ${budget.targetWords}`;
} else {
  modeInstructions = `
🎯 CHẾ ĐỘ: LÝ THUYẾT CƠ BẢN
- Ưu tiên: định nghĩa rõ ràng, ví dụ đơn giản, liệt kê có cấu trúc
- Cấu trúc: Khái niệm → Ví dụ → Tóm tắt ghi nhớ
- Từ số: ${budget.targetWords}
- Mỗi khái niệm chính có ít nhất 1 ví dụ minh họa`;
}

// =========================
// MAIN PROMPT
// =========================
const contentPrompt = `Bạn là BIÊN TẬP VIÊN giáo dục. Nhiệm vụ: TỔ CHỨC LẠI kiến thức từ tài liệu gốc thành bài giảng có cấu trúc.
${contextWeakHint ? contextWeakHint + "\n" : ""}
⚠️ QUY TẮC BẮT BUỘC (vi phạm = bài bị huỷ):
- CHỈ dùng thông tin CÓ TRONG CONTEXT bên dưới — đây là nguồn duy nhất
- KHÔNG suy diễn, KHÔNG thêm kiến thức ngoài CONTEXT dưới bất kỳ hình thức nào
- KHÔNG lặp lại nội dung các bài trước
- Nếu CONTEXT không đề cập → viết "[Tài liệu không đề cập]" thay vì tự bịa
- ƯU TIÊN trích dẫn nguyên văn hoặc diễn giải sát nghĩa từ CONTEXT
- Mỗi luận điểm PHẢI có cơ sở trong CONTEXT — không được tự thêm ví dụ bịa
${conceptMemoryBlock}
${codeExampleHint}
${requiredFactsBlock}
${modeInstructions}
${scopeBlock}

===== CONTEXT =====
${safeContext}
==================

===== BÀI TRƯỚC (CẤM LẶP) =====
${previousBlock}
================================

THÔNG TIN BÀI:
- Chủ đề: ${searchTopic}
- Ngày: ${dayNumber}/${totalDays}
- Bloom: ${bloomLevel} (${bloomInstruction})
- Mục tiêu: ${objective || "Bám sát nội dung cốt lõi"}
- Người học: ${selectedPersona}

CẤU TRÚC BÀI GIẢNG — HARD FRAME + SOFT FRAME

━━ HARD FRAME (BẮT BUỘC — không bỏ sót) ━━━━━━━━━━━━━━━━━━━━━━━━

## 1. Giới thiệu & Bối cảnh
(1-3 câu: tại sao chủ đề này cần học, liên kết với kiến thức trước.
Nếu CONTEXT không có thông tin nền → viết 1 câu giới thiệu chủ đề là đủ.)

## 2. Nội dung chính
[→ Xem SOFT FRAME bên dưới — chọn MỘT pattern phù hợp nhất với CONTEXT]

## 3. Tổng kết & Ghi nhớ
- Bullet 3-5 điểm then chốt rút ra từ CONTEXT
- 1 câu bridge sang chủ đề tiếp (bỏ qua nếu là ngày ${dayNumber} = ngày cuối ${totalDays})

━━ SOFT FRAME — CHỌN 1 PATTERN PHÙ HỢP VỚI CONTEXT ━━━━━━━━━━━━━━

[SF-A] KHÁI NIỆM & CƠ CHẾ — dùng khi CONTEXT giải thích định nghĩa/nguyên lý:
  ### Định nghĩa
  ### Nguyên lý hoạt động
  ### Ví dụ minh hoạ

[SF-B] BÀI TẬP & ỨNG DỤNG — dùng khi CONTEXT chứa nhiều ví dụ/bài tập:
  ### Bài toán mẫu
  (trình bày đề bài rõ, giải từng bước)
  ### Dạng bài thường gặp
  ### Lưu ý khi làm bài

[SF-C] CÔNG THỨC & TÍNH TOÁN — dùng khi CONTEXT có công thức/bảng số liệu:
  ### Công thức cốt lõi
  (viết rõ ý nghĩa từng biến)
  ### Điều kiện áp dụng
  ### Ví dụ tính toán

[SF-D] CHỨNG MINH & SUY LUẬN — dùng khi CONTEXT là định lý/bổ đề/proof:
  ### Phát biểu
  ### Điều kiện / Giả thiết
  ### Chứng minh (từng bước)
  ### Hệ quả & Ứng dụng

[SF-E] QUY TRÌNH & TIMELINE — dùng khi CONTEXT mô tả các bước/giai đoạn:
  ### Tổng quan quy trình
  ### Bước 1 / Giai đoạn 1...
  ### Lưu ý & Điểm kiểm soát

[SF-F] SO SÁNH & PHÂN LOẠI — dùng khi CONTEXT liệt kê nhiều loại/phương án:
  ### Phân loại tổng quan
  ### So sánh chi tiết (bảng nếu được)
  ### Hướng dẫn chọn lựa

NGUYÊN TẮC CHỌN SOFT FRAME:
- Đọc CONTEXT → nhận diện nội dung thuộc dạng nào → chọn pattern tương ứng
- KHÔNG bắt buộc dùng đúng tên section như template — tự điều chỉnh tên cho phù hợp chủ đề
- Nếu CONTEXT pha trộn nhiều dạng → ghép 2 pattern, ưu tiên phần chiếm nhiều nhất
- Nếu CONTEXT rất ngắn/thưa → dùng SF-A nhưng cho phép Section 2 ngắn hơn bình thường

YÊU CẦU FORMAT:
- Markdown chuẩn (##, ###, bullet, code fence nếu có code)
- KHÔNG có quiz, JSON, hay meta-commentary
- Mỗi phần ## PHẢI có ít nhất 2 dòng nội dung

⚠️ QUY TẮC BIÊN TẬP (QUAN TRỌNG NHẤT):
- Mỗi luận điểm PHẢI xuất phát từ thông tin có trong CONTEXT
- Nếu CONTEXT không đề cập đến thông tin → KHÔNG viết về thông tin đó
- Ưu tiên PARAPHRASE (diễn giải lại) hoặc TRÍCH DẪN TRỰC TIẾP từ CONTEXT
- Khi không chắc chắn → dùng câu "Theo tài liệu..." hoặc bỏ qua
`;

  // =========================
  // GENERATOR
  // =========================
  const generateContent = async (temperature, extraInstruction = "") => {
    let content = await makeGroqPlainRequest({
      messages: [
        {
          role: "system",
          content:
            "Bạn là biên tập viên giáo dục. Nhiệm vụ là TỔ CHỨC LẠI nội dung từ tài liệu gốc, TUYỆT ĐỐI không được thêm kiến thức ngoài CONTEXT. Nếu không có thông tin trong CONTEXT → viết [Tài liệu không đề cập] thay vì tự thêm vào.",
        },
        {
          role: "user",
          content: contentPrompt + "\n\n" + extraInstruction,
        },
      ],
      model: contentModel,
      temperature,
      maxTokens: budget.contentTokens,
    });

    // clean markdown wrapper
    content = content
      .replace(/^```(?:markdown|md)?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();

      content = stripPromptLeakage(content);
    // remove accidental quiz
    for (const marker of ["### Quiz", "## Quiz", "---\n**Quiz"]) {
      const idx = content.indexOf(marker);
      if (idx !== -1) content = content.slice(0, idx).trim();
    }

    // ✅ FIX: Xóa các dòng chunk metadata header lọt vào content
    content = content
      .split("\n")
      .filter(line => {
        const t = line.trim();
        if (/^\*\s*\[Context:/i.test(t)) return false;   // * [Context: ...]
        if (/^-\s*\[Context:/i.test(t)) return false;    // - [Context: ...]
        if (/^\[Context:/i.test(t)) return false;         // [Context: ...]
        if (/^\[BẢNG DỮ LIỆU/i.test(t)) return false;   // [BẢNG DỮ LIỆU...]
        return true;
      })
      .join("\n")
      .trim();



    return content;
  };


  try {
    let content = await generateContent(profile.focus === "practice" ? 0.2 : 0.1);

    // =========================
    // POST-GEN: XÓA CODE BLOCK BỊA
    // =========================
    content = stripInvalidCodeBlocks(content, safeContext);
    console.log(`[CodeGuard] Day ${dayNumber} — đã kiểm tra code blocks`);

    // =========================
    // SCOPE VALIDATION (FIX-UP)
    // =========================
    const scopeResult = validateScopeCompliance(content, item, previousSummaries);
    if (!scopeResult.ok) {
      console.warn(`[ScopeGuard] Day ${dayNumber} violations:`, scopeResult.violations);

      // regenerate với constraint mạnh hơn
      content = await generateContent(
        0.05,
        "Sửa lại: loại bỏ mọi nội dung ngoài phạm vi. Chỉ giữ nội dung hợp lệ."
      );
      // ✅ Strip lại sau regenerate
      content = stripInvalidCodeBlocks(content, safeContext);
    }

    // =========================
    // ANTI DUP (SMART)
    // =========================
    const dupResults = checkContentDuplication(content, previousSummaries);
    const highDup = dupResults.filter((d) => d.ratio > 65);

    if (highDup.length > 0) {
      console.warn(`[AntiDup] Day ${dayNumber} high overlap:`, highDup);

      content = await generateContent(
        0.05,
        "Viết lại hoàn toàn. Tránh trùng lặp ý tưởng với các bài trước."
      );
      // ✅ Strip lại sau antidup regenerate
      content = stripInvalidCodeBlocks(content, safeContext);
    }

    // =========================
    // TWO-PASS VERIFICATION (HALLUCINATION CHECK)
    // Dùng LLM nhỏ (8b) quét nội dung — đánh dấu các đoạn
    // AI có thể đã thêm thông tin NGOÀI context.
    // Nhẹ: chỉ chạy khi content > 400 ký tự, không retry nếu fail.
    // =========================
    if (content.length > 400 && safeContext.length > 100) {
      try {
        const verifyPrompt = `Bạn là kiểm duyệt viên nội dung học thuật.

CONTEXT TÀI LIỆU GỐC (nguồn duy nhất hợp lệ):
---
${safeContext.slice(0, 3000)}
---

BÀI GIẢNG DO AI SINH (cần kiểm tra):
---
${content.slice(0, 2000)}
---

NHIỆM VỤ: Tìm các đoạn trong BÀI GIẢNG có thể chứa thông tin KHÔNG có trong CONTEXT.
- Nếu bài giảng hoàn toàn bám sát context → trả về: {"ok": true, "flagged": []}
- Nếu có đoạn nghi ngờ → trả về: {"ok": false, "flagged": ["đoạn nghi ngờ 1 (tối đa 60 ký tự)", "..."]}
- Chỉ flag khi CHẮC CHẮN không có trong context, không flag khi không chắc.

Chỉ trả về JSON, không giải thích thêm.`;

        const verifyRes = await makeGroqRequest({
          messages: [
            { role: "system", content: "Chỉ trả về JSON hợp lệ." },
            { role: "user", content: verifyPrompt },
          ],
          model: MODEL_FAST,
          temperature: 0.0,
          maxTokens: 400,
          enforceJSON: true,
        });

        const verifyData = safeJSONParse(verifyRes);

        if (verifyData && !verifyData.ok && Array.isArray(verifyData.flagged) && verifyData.flagged.length > 0) {
          console.warn(`[TwoPass] Day ${dayNumber} — phát hiện ${verifyData.flagged.length} đoạn nghi ngờ:`, verifyData.flagged);
          // Gắn cảnh báo nhẹ cuối bài thay vì xóa nội dung (tránh mất nhiều thông tin đúng)
          content += `\n\n> ⚠️ *Lưu ý: Một số nội dung trong bài có thể cần đối chiếu lại với tài liệu gốc.*`;
        } else {
          console.log(`[TwoPass] Day ${dayNumber} — nội dung bám sát context ✅`);
        }
      } catch (verifyErr) {
        // Two-Pass fail không được làm hỏng flow chính
        console.warn(`[TwoPass] Day ${dayNumber} — skip (lỗi):`, verifyErr.message);
      }
    }

    // =========================
    // FINAL SAFETY CUT (FIX-NEW)
    // =========================
    if (content.length < 100) {
      console.warn(`[ContentTooShort] Day ${dayNumber}`);
    }

    return content;

  } catch (err) {
    console.warn("[Phase1] Content failed:", err.message);

    if (contentModel === MODEL_SMART) {
      try {
        const res = await makeGroqPlainRequest({
          messages: [
            { role: "system", content: "Viết bài Markdown ngắn gọn, đúng context." },
            { role: "user", content: contentPrompt },
          ],
          model: MODEL_FAST,
          temperature: 0.1,
          maxTokens: LESSON_BUDGET_NORMAL.contentTokens,
        });

        return res
          .replace(/^```(?:markdown|md)?\n?/i, "")
          .replace(/\n?```$/i, "")
          .trim();
      } catch (fe) {
        console.warn("[Fallback failed]:", fe.message);
      }
    }

    return `## ${searchTopic}\n\nNội dung đang được cập nhật từ tài liệu gốc.`;
  }
};

// ─────────────────────────────────────────────
// 1. SYLLABUS GENERATION — FIXED [FIX-5]
// ─────────────────────────────────────────────
/////////////////////////////////
////////////////////////////////
///////////////////////////////
///////////////////////////////
////////////////////////////////
///////////////////////////////
//////////////////////////////////
/////////////////////////////////
////////////////////////////////////
///////////////////////////////////
////////////////////////////////////
///////////////////////////////////
// ─────────────────────────────────────────────
// HELPERS (NEW)
// ─────────────────────────────────────────────

const generateSmartTitle = (text, index) => {
  const words = (text || "").split(" ").slice(0, 6).join(" ");
  return words && words.length > 10 ? words : `Chủ đề ${index + 1}`;
};

// ✅ FIX: Chia block liên tiếp thay vì round-robin.
// Round-robin cũ: ngày 1 ← section 1,8,15 (không liên quan)
// Fix mới: ngày 1 ← section 1,2,3 (liên tiếp — hợp lý học thuật)
const distributeSections = (outline, numDays) => {
  if (!outline.length) return Array.from({ length: numDays }, () => []);
  const result = Array.from({ length: numDays }, () => []);
  const chunkSize = Math.ceil(outline.length / numDays);
  outline.forEach((section, i) => {
    const dayIdx = Math.min(Math.floor(i / chunkSize), numDays - 1);
    result[dayIdx].push(section);
  });
  return result;
};

const normalizeVN = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();

// ─────────────────────────────────────────────
// FALLBACK PLAN (IMPROVED)
// ─────────────────────────────────────────────

const buildFallbackPreviewPlan = (text, days) => {
  const clean = normalizeSpace(text || "").slice(0, 1500);

  const parts = clean
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  const uniqueParts = [...new Set(parts)];

  return Array.from({ length: days }, (_, i) => {
    const snippet =
      uniqueParts[i] ||
      uniqueParts[i % uniqueParts.length] ||
      "Nắm vững nội dung cốt lõi";

    const bloom = getBloomLevel(i, days);

    return {
      dayNumber: i + 1,
      title: generateSmartTitle(snippet, i),
      objective: snippet.slice(0, 140),
      bloomLevel: bloom.label,
      coveredSections: [snippet.slice(0, 60)],
    };
  });
};

// ─────────────────────────────────────────────
// GENERATE SYLLABUS (FIXED PRODUCTION VERSION)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 📚 HÀM 1: SINH KHUNG CHƯƠNG TRÌNH HỌC (generateSyllabus)
//
// Mục đích: Dựa vào toàn bộ tài liệu, phân bổ kiến thức thành N ngày học.
// Ví dụ: Tài liệu SQL có 6 chương, học 7 ngày → AI sẽ gộp/chia đều ra 7 phần.
//
// Trong mỗi đối tượng ngày học bao gồm:
//   - dayNumber     : Ngày thứ mấy (1, 2, 3,...)
//   - title         : Tên chủ đề sẽ học
//   - objective     : Mục tiêu cụ thể cần đạt
//   - bloomLevel    : Cấp độ tư duy Bloom (Remember, Understand, Apply,...)
//   - coveredSections: Danh sách phần tài liệu sẽ bao quát trong ngày đó
//
// Cơ chế an toàn:
//   - Nếu AI trả về ít ngày hơn yêu cầu → tự động bổ sung bằng buildFallbackPreviewPlan()
//   - Nếu AI trả về thừa ngày → cắt bịt phần thừa
//   - Nếu một ngày không có coveredSections → tự gán từ outline của tài liệu
// ─────────────────────────────────────────────────────────────────────────────
const generateSyllabus = async (rawText, numDays, learningGoalsInput = null) => {
  const learningGoals = normalizeLearningGoals(learningGoalsInput || {});
  const textForOutline = mergeBrokenNumberedHeadings(rawText || "");
  const objectiveSeeds = getObjectiveSeedsFromText(textForOutline, numDays);
  const outline = extractDocumentOutline(textForOutline);

  const outlineBlock =
    outline.length > 0
      ? outline.map((h, i) => `${i + 1}. ${h}`).join("\n")
      : "(Không nhận diện được outline — dùng text thô)";

  const breadthNote =
    outline.length > numDays
      ? `\nCHIẾN LƯỢC GỘP: ~${outline.length} phần / ${numDays} ngày → mỗi ngày phải gộp.`
      : "";

  const bloomHints = Array.from({ length: numDays }, (_, i) => {
    const bloom = getBloomLevel(i, numDays);
    return `Ngay ${i + 1} -> ${bloom.vi} (${bloom.label})`;
  }).join("\n");

  // Tạo skeleton dayNumber để nhắc AI phải điền đủ
  const daySkeleton = Array.from({ length: numDays }, (_, i) =>
    `{"dayNumber":${i + 1},"title":"...","objective":"...","bloomLevel":"${getBloomLevel(i, numDays).label}","coveredSections":["..."]}`
  ).join(',\n');

  const syllabusPrompt = `Bạn là chuyên gia biên tập và thiết kế chương trình học.

⚠️ BẮT BUỘC: Trả về ĐÚNG ${numDays} object trong mảng "syllabus".
⚠️ KHÔNG ĐƯỢC dừng sớm. Mảng syllabus phải có ĐÚNG ${numDays} phần tử.

OUTLINE tài liệu:
${outlineBlock}
${breadthNote}

MỤC TIÊU: ${syllabusBiasInstructions(learningGoals)}

BLOOM từng ngày:
${bloomHints}

QUY TẮC BẮT BUỘC:
1. Bạn là người BIÊN TẬP/PHÂN CHIA bài học từ tài liệu gốc. KHÔNG tự sáng tạo thêm kiến thức mới không có trong tài liệu.
2. Bao phủ toàn bộ outline của tài liệu gốc, KHÔNG bỏ sót bất kỳ phần hay chương quan trọng nào trong outline trên.
3. Không trùng lặp chủ đề giữa các ngày.
4. coveredSections KHÔNG được rỗng và các phần tử trong đó phải lấy trực tiếp hoặc bám cực sát theo outline của tài liệu gốc.
5. Sắp xếp logic từ cơ bản → nâng cao.
6. Tiêu đề bài học ngắn gọn (<= 6 từ).

TRẢ VỀ JSON sau (điền đầy đủ ${numDays} ngày):
{
"title": "...",
"syllabus":[
${daySkeleton}
]
}`;

  const response = await makeGroqRequest({
    messages: [
      { role: "system", content: "Chỉ trả về JSON hợp lệ." },
      { role: "user", content: syllabusPrompt + "\n\nTEXT:\n" + textForOutline.substring(0, MAX_SYLLABUS_TEXT) }
    ],
    model: MODEL_FAST,
    temperature: 0.1,
    maxTokens: Math.max(4000, numDays * 350), // ~350 tokens/ngày để đủ cho 14 ngày
    enforceJSON: true,
  });

  let data = safeJSONParse(response);

  // 🔥 JSON fallback
  if (!data || !Array.isArray(data.syllabus)) {
    console.warn("[Syllabus] JSON lỗi → fallback");
    return {
      title: "Khóa học tự động",
      syllabus: buildFallbackPreviewPlan(textForOutline, numDays),
    };
  }

  const usedTitles = new Set();
  const usedObjectives = new Set();

  const distributedSections = distributeSections(outline, numDays);

  const syllabus = data.syllabus.map((item, i) => {
    let title = item.title || "";
    let objective = normalizeSpace(item.objective || "");
    const bloom = getBloomLevel(i, numDays);

    // FIX objective rỗng / generic
    const objKey = objective.slice(0, 60).toLowerCase();
    const isGeneric =
      !objective ||
      objective.length < 20 ||
      /(tong quan|gioi thieu|overview|introduction)/i.test(objective) ||
      usedObjectives.has(objKey);

    if (isGeneric) {
      objective =
        objectiveSeeds[i] ||
        `Nắm vững nội dung ${bloom.vi} ngày ${i + 1}.`;
    }
    usedObjectives.add(objective.slice(0, 60).toLowerCase());

    // FIX duplicate title
    let titleKey = normalizeTitle(title).replace(/\d+/g, "");
    let suffix = 2;
    while (usedTitles.has(titleKey)) {
      title = `${title} (${suffix})`;
      suffix++;
    }
    usedTitles.add(titleKey);

    // FIX coveredSections
    let coveredSections = (item.coveredSections || []).filter(Boolean);
    coveredSections = coveredSections.filter((s) => s.length > 3);

    if (coveredSections.length === 0) {
      if (distributedSections[i]?.length) {
        coveredSections = distributedSections[i];
      } else if (outline.length > 0) {
        coveredSections = [outline[i % outline.length]];
      } else {
        coveredSections = [title || `Nội dung ngày ${i + 1}`];
      }

      console.log(`[FIX] Day ${i + 1}: auto-fill sections`, coveredSections);
    }

    return {
      dayNumber: item.dayNumber || i + 1,
      title,
      objective,
      bloomLevel: item.bloomLevel || bloom.label,
      coveredSections,
    };
  });

  // 🔥 coverage check (improved)
  if (outline.length > 0) {
    const coveredSet = new Set(
      syllabus.flatMap((s) => s.coveredSections.map(normalizeVN))
    );

    const uncovered = outline.filter((sec) => {
      const key = normalizeVN(sec).slice(0, 30);
      return key.length > 4 && !coveredSet.has(key);
    });

    if (uncovered.length > 0) {
      console.warn(`[Coverage] Missing sections:`, uncovered.slice(0, 5));

      uncovered.forEach((sec, idx) => {
        const target =
          syllabus[syllabus.length - 1 - (idx % syllabus.length)];
        if (target && !target.coveredSections.includes(sec)) {
          target.coveredSections.push(sec);
        }
      });
    }
  }

  // 🔥 HARD FIX: AI thường trả về ít ngày hơn numDays yêu cầu
  // → pad thêm ngày còn thiếu bằng fallback, trim nếu thừa
  if (syllabus.length !== numDays) {
    console.warn(`[Syllabus] AI trả về ${syllabus.length} ngày, yêu cầu ${numDays} → điều chỉnh`);

    if (syllabus.length < numDays) {
      // Pad thêm các ngày còn thiếu
      const fallback = buildFallbackPreviewPlan(textForOutline, numDays);
      for (let i = syllabus.length; i < numDays; i++) {
        const bloom = getBloomLevel(i, numDays);
        syllabus.push(
          fallback[i] || {
            dayNumber: i + 1,
            title: `Nội dung ngày ${i + 1}`,
            objective: `Nắm vững nội dung ${bloom.vi} ngày ${i + 1}.`,
            bloomLevel: bloom.label,
            coveredSections: [outline[i % Math.max(outline.length, 1)] || `Phần ${i + 1}`],
          }
        );
      }
    } else {
      // Trim nếu AI trả về thừa ngày
      syllabus.length = numDays;
    }

    // Chuẩn hóa lại dayNumber sau khi pad/trim
    syllabus.forEach((item, i) => { item.dayNumber = i + 1; });
  }

  return { title: data.title, syllabus };
};
// ─────────────────────────────────────────────────────────────────────────────
// 📦 HÀM 2: CẮT NHỏ TÀI LIỆU & LƯU TRữ VECTOR (processAndStoreDocument)
//
// Mục đích: Chuẩn bị dữ liệu cho kỹ thuật RAG (Retrieval-Augmented Generation).
// Khi AI cần viết bài ngày 3 về SQL Stored Procedure → nó sẽ tìm trong DB
// xem có chunk nào nói về Stored Procedure không, rồi dùng làm cơ sở viết.
//
// Các bước xử lý bên trong:
//   B1: cleanText()    - Xóa ký tù rác, OCR lỗi, chuẩn hóa unicode
//   B2: chunkText()    - Cắt tài liệu thành các đoạn nhỏ (~500-1000 ký tự/chunk)
//   B3: classifyChunks() - Xác định từng chunk thuộc chủ đề gì (SQL, toán, văn...)
//   B4: generateEmbedding() - Biến mỗi chunk thành mảng số (Vector) đại diện ý nghĩa ngữ nghĩa
//   B5: Chunk.insertMany() - Lưu tất cả vào MongoDB để dùng khi tìm kiếm sau này
//
// Tại sao phải cắt nhỏ?
//   - Tài liệu dài hàng ngàn từ KHÔNG thể nhét hết vào 1 lần gọi AI (giới hạn context)
//   - Cắt nhỏ rồi vít riêng phần cần thiết giúp AI tập trung hơn, chính xác hơn
// ─────────────────────────────────────────────────────────────────────────────
// Giới hạn tối đa số chunk để nhúng — tài liệu học thuật dài có thể sinh
// hàng trăm chunk, gây timeout và tốn quá nhiều API call embedding.
// Strategy: giữ 60% đầu (intro + nội dung chính) + 40% sampled từ phần còn lại.
const MAX_EMBED_CHUNKS = 150;

// ✅ FIX: Uniform sampling toàn bộ tài liệu — không ưu tiên phần đầu.
// Tài liệu học thuật: nội dung cốt lõi thường nằm giữa (chương 2-4),
// không nhất thiết ở phần đầu. 60/40 split bỏ sót nội dung quan trọng.
const capChunksForLargeDoc = (allChunks) => {
  if (allChunks.length <= MAX_EMBED_CHUNKS) return allChunks;

  console.warn(
    `[Chunk] ⚠️ Tài liệu lớn: ${allChunks.length} chunks → giới hạn còn ${MAX_EMBED_CHUNKS} (uniform sampling).`
  );

  const step = allChunks.length / MAX_EMBED_CHUNKS;
  const sampled = Array.from({ length: MAX_EMBED_CHUNKS }, (_, i) =>
    allChunks[Math.min(Math.round(i * step), allChunks.length - 1)]
  );

  return sampled;
};

const processAndStoreDocument = async (planId, text) => {
  const cleaned = cleanText(text);

  // ── SMART CHUNKER SELECTION ───────────────────────────────────────
  // Bước 1: Dùng rule-based chunker trước
  let rawChunks = chunkText(cleaned);

  // Đánh giá chất lượng cấu trúc tài liệu:
  // Nếu < 20% chunk có section heading → tài liệu nghèo cấu trúc
  // (OCR thô, văn xuôi liên tục, không đầu mục)
  // → dùng AI chunker để cắt semantic tốt hơn
  const chunksWithSection = rawChunks.filter(c => c.section && c.section.trim().length > 2);
  const headingDensity = rawChunks.length > 0 ? chunksWithSection.length / rawChunks.length : 1;

  console.log(`[Chunk] heading density: ${(headingDensity * 100).toFixed(0)}% (${chunksWithSection.length}/${rawChunks.length} chunks có section header)`);

  if (headingDensity < 0.20 && rawChunks.length >= 5) {
    console.log("[Chunk] Cấu trúc tài liệu yếu → thử AI chunker...");
    try {
      const aiChunks = await aiChunkText(cleaned);
      if (aiChunks && aiChunks.length >= rawChunks.length * 0.5) {
        // AI chunker trả về kết quả hợp lý → dùng
        rawChunks = aiChunks;
        console.log(`[Chunk] AI chunker: ${aiChunks.length} chunks (thay thế rule-based)`);
      } else {
        console.warn("[Chunk] AI chunker trả về quá ít chunk → giữ rule-based.");
      }
    } catch (aiErr) {
      console.warn("[Chunk] AI chunker lỗi → giữ rule-based:", aiErr.message);
    }
  }

  if (!rawChunks.length) {
    console.warn("[Chunk] Không có chunk nào.");
    return;
  }

  // ── TOPIC CLASSIFICATION ─────────────────────────────────
  const classifiedAll = classifyChunks(rawChunks);

  // ── PROPOSITION EXPANSION (granular RAG) ───────────────────
  // Với mỗi chunk lớn (> 150 từ), sinh thêm các proposition nhỏ
  // để vector search tìm được sự kiện cụ thể chính xác hơn.
  // Giới hạn: tối đa 3 propositions/chunk để không tăng quá nhiều DB writes.
  const MAX_PROPOSITIONS_PER_CHUNK = 3;
  const PROPOSITION_MIN_WORDS = 6;

  const propositionChunks = [];
  for (const chunk of classifiedAll) {
    if ((chunk.wordCount || 0) > 150 && typeof splitIntoPropositions === "function") {
      try {
        const props = splitIntoPropositions(chunk);
        const selected = props
          .filter(p => p.wordCount >= PROPOSITION_MIN_WORDS)
          .slice(0, MAX_PROPOSITIONS_PER_CHUNK);

        for (const p of selected) {
          propositionChunks.push({
            index    : -1, // sẽ re-index sau
            section  : chunk.section || "",
            topic    : chunk.topic || "general",
            content  : p.content,
            wordCount: p.wordCount,
            chunkType: "proposition", // nhãn để phân biệt
          });
        }
      } catch (_) { /* bỏ qua nếu lỗi proposition */ }
    }
  }

  // Gộp parent chunks + propositions; re-index
  const allChunksForEmbed = [...classifiedAll, ...propositionChunks]
    .map((c, i) => ({ ...c, index: i }));

  console.log(`[Chunk] ${classifiedAll.length} parent chunks + ${propositionChunks.length} propositions = ${allChunksForEmbed.length} total`);

  // ── CAP chunks cho tài liệu lớn ──────────────────────────────
  const chunks = capChunksForLargeDoc(allChunksForEmbed);

  const requestedConcurrency = Number(process.env.EMBEDDING_CONCURRENCY || 2);
  const concurrency = Math.max(1, Math.min(3, requestedConcurrency));

  console.log(`[Embedding] ${chunks.length}/${rawChunks.length} chunks | concurrency: ${concurrency}`);

  // 🔥 tránh duplicate insert
  await Chunk.deleteMany({ planId });

  let index = 0;

  const results = new Array(chunks.length);

  const worker = async () => {
    while (true) {
      const i = index++;
      if (i >= chunks.length) break;

      const c = chunks[i];

      try {
        // 🔥 tránh rate limit
        // 800ms đủ để tránh rate-limit với concurrency=2 (~1600ms/req cho từng API slot)
        if (i > 0) await sleep(800);

        // 🔥 truncate limit lớn hơn để không mất context
        const safeContent = c.content.slice(0, 3000);

        const embedding = await retryWithBackoff(
          () => generateEmbedding(safeContent, "passage"),
          3
        );

        if (!embedding || embedding.length === 0) {
          console.warn(`[Chunk ${i}] embedding null → skip`);
          continue;
        }

        results[i] = {
          planId,
          content: safeContent,
          embedding,
          chunkIndex: c.index ?? i,
          section: sanitizeSectionName(c.section || ""),
          topic: c.topic || "general",
          // ✅ IMPROVEMENT: Metadata phượng pháp để truy vết và lọc chunk thông minh hơn
          chunkType: c.chunkType || "text",
          metadata: {
            wordCount  : c.wordCount || safeContent.split(" ").length,
            hasCode    : c.hasCode    ?? /```[\s\S]+?```/.test(safeContent),
            hasTable   : c.hasTable   ?? /^\|.+\|/m.test(safeContent),
            hasFormula : c.hasFormula ?? /\$[^$]+\$/.test(safeContent),
          },
        };

      } catch (err) {
        console.error(`[Chunk ${i}] error:`, err.message);
      }
    }
  };

  // chạy workers
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker())
  );

  // lọc null + giữ order
  const docs = results.filter(Boolean);

  if (!docs.length) {
    console.warn("[Embedding] Không có chunk hợp lệ.");
    return;
  }

  docs.sort((a, b) => a.chunkIndex - b.chunkIndex);

  // 🔥 insert theo batch (an toàn DB)
  const BATCH_SIZE = 50;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    try {
      await Chunk.insertMany(batch, { ordered: false });
    } catch (err) {
      console.error("[DB] Batch insert lỗi:", err.message);
    }
  }

  console.log(`[Embedding] Đã lưu ${docs.length}/${chunks.length} chunks.`);
};
// ─────────────────────────────────────────────────────────────────────────────
// 🧠 HÀM 3: SINH BÀI GIẢNG CHI TIẾT BẰỚC RAG (generateScientificLesson)
//
// Đây là hàm QUAN TRỌNG NHẤT, điều phối toàn bộ quá trình tạo 1 ngày học.
//
// Tham số đầu vào:
//   - planId         : ID của lộ trình (dùng để tìm chunk phù hợp trong DB)
//   - item           : Thông tin ngày học {day, topic, objective, coveredSections, ...}
//   - userId         : ID học viên (dùng để xác định trình độ: REMEDIAL/NORMAL/ADVANCED)
//   - usedChunkSignatures: Chunk đã dùng ngày trước (tránh lấy cùng 1 đoạn 2 lần)
//   - previousSummaries : Tóm tắt các bài đã dạy (AI biết không được lặp lại)
//   - usedConcepts   : Khái niệm đã dạy (đưa vào prompt nhắc AI không giải thích lại)
//
// Chuỗi xử lý bên trong:
//   B1: getLearningMode()    - Xác định học viên đang ở trình độ nào (remedial/normal/advanced)
//   B2: generateHyDE()      - Tạo đoạn văn giả định để tìm kiếm vector chính xác hơn
//   B3: searchChunksBySection() / searchRelevantChunks() - Tìm các chunk tài liệu phù hợp nhất
//   B4: selectDiverseChunks() - Chọn đa dạng, tránh chọn các chunk quá giống nhau
//   B5: generateLessonContent() - Gọi AI viết nội dung bài giảng Markdown
//   B6: generateLessonMeta()    - Gọi AI tạo câu hỏi trắc nghiệm + tóm tắt
//   B7: extractConcepts()    - Trích xuất khái niệm vừa dạy (trả về có nhớ theo dõi)
// ─────────────────────────────────────────────────────────────────────────────
const generateScientificLesson = async (
  planId, item, userId = null,
  previousTopics = [],
  usedChunkSignatures = [],
  learningProfile = null,
  previousSummaries = [],
  usedConcepts = []          // ← MỚI: danh sách concept đã dạy từ ngày trước
) => {
  try {
    const profile = normalizeLearningGoals(learningProfile || {});
    const quizBounds = getQuizBounds(profile);
    const practiceBias = profile.focus === "practice";

    const topic = item.topic || `Bài học ngày ${item.day || 1}`;
    const objective = item.objective || "";
    const totalDays = item.totalDays || 7;

    const bloomLevel =
      item.bloomLevel ||
      getBloomLevel((item.day || 1) - 1, totalDays).label;

    const mode = userId ? await getLearningMode(userId, topic) : "NORMAL";

    const personaMap = {
      REMEDIAL: "Giải thích đơn giản, nhiều ví dụ đời thường.",
      NORMAL: "Giảng dạy chuẩn, logic rõ ràng.",
      ADVANCED: "Phân tích sâu, kỹ thuật, có edge cases.",
    };

    const selectedPersona = personaMap[mode] || personaMap.NORMAL;

    const bloomDepthMap = {
      Remember: "Định nghĩa và ghi nhớ.",
      Understand: "Giải thích và diễn giải.",
      Apply: "Áp dụng vào ví dụ.",
      Analyze: "Phân tích cấu trúc.",
      Evaluate: "Đánh giá và so sánh.",
      Create: "Tổng hợp và đề xuất.",
    };

    const bloomInstruction =
      bloomDepthMap[bloomLevel] || "Nắm vững nội dung.";

    const searchTopic =
      topic.includes(" - ") ? topic.split(" - ").pop() : topic;

    // ─────────────────────────────
    // RAG PIPELINE (SAFE MODE)
    // ─────────────────────────────

    let queryVector = null;

    try {
      const hydePassage = await generateHyDE(searchTopic, objective);
      queryVector = await generateEmbedding(`passage: ${hydePassage}`, "query");
    } catch (err) {
      console.warn("[RAG] HyDE failed → fallback:", err.message);
    }

    const coveredSectionsList = item.coveredSections || [];

    let contextChunks = [];

    try {
      if (coveredSectionsList.length > 0) {
        contextChunks = await searchChunksBySection(
          planId,
          coveredSectionsList,
          queryVector,
          CHUNK_SEARCH_K
        );
      }

      // fallback nếu section fail hoặc rỗng
      if (!contextChunks.length) {
        console.warn("[RAG] fallback → vector search");
        contextChunks = await searchRelevantChunks(
          planId,
          queryVector,
          CHUNK_SEARCH_K
        );
      }

    } catch (err) {
      console.error("[RAG] search failed:", err.message);
    }

    // ─────────────────────────────
    // CHUNK FILTER + DEDUP
    // ─────────────────────────────

    let scoredChunks = filterChunksByScore(
      contextChunks,
      CHUNK_SCORE_THRESHOLD,
      2
    );

    let selectedChunks = selectDiverseChunks(
      scoredChunks,
      usedChunkSignatures,
      CHUNK_USE_K
    );

    // fallback nếu không có chunk tốt
    if (!selectedChunks.length && contextChunks.length > 0) {
      selectedChunks = contextChunks.slice(0, 2);
    }

    const currentChunkSigs = selectedChunks.map((c) =>
      getChunkSignature(c.content)
    );

    // ─────────────────────────────
    // CONTEXT BUILD (SAFE)
    // ─────────────────────────────

    let context = "Không có context.";
    if (selectedChunks.length) {
      // ✅ FIX: sort theo chứ tự gốc tài liệu (chunkIndex) để AI đọc context theo đúng flow kiến thức
      const ordered = [...selectedChunks].sort((a, b) => {
        const ai = a.chunkIndex ?? a.index ?? 9999;
        const bi = b.chunkIndex ?? b.index ?? 9999;
        return ai - bi;
      });
      context = ordered.map((c) => c.content).join("\n---\n");
    }

    // ✅ FIX: tăng limit để không cắt mất kiến thức quan trọng + ví dụ code dài
    // 70b model có 128k context → 9000 chars (~3000 tokens) vẫn an toàn
    context = context.slice(0, 9000);

    const formulaNotesFromContext =
      extractFormulaLikeNotes(context);

    // ✅ FIX #2: Trích xuất tên SP/bảng/biến từ context để nhắc AI dùng đúng
    const codeIdentifiersFromContext = extractCodeIdentifiers(context);

    // ✅ FIX: Trích xuất các sự kiện/phân loại quan trọng để AI không bỏ sót
    const keyFactsFromContext = extractKeyFacts(context);

    // ✅ FIX: Cảnh báo khi context quá ngắn — AI không nên cố viết dài khi thiếu dữ liệu
    let contextWeakHint = "";
    if (context.length < 500 && context !== "Không có context.") {
      contextWeakHint = "\n⚠️ CONTEXT RẤT NGẮN — chỉ viết những gì có trong CONTEXT, bài có thể ngắn, KHÔNG CỐ kéo dài.";
      console.warn(`[ContextWeak] Day ${item.day} — context chỉ có ${context.length} ký tự`);
    }

    // ─────────────────────────────
    // PHASE 1: CONTENT
    // ─────────────────────────────

    const lessonContent = await generateLessonContent({
      searchTopic,
      bloomLevel,
      bloomInstruction,
      objective,
      selectedPersona,
      profile,
      context,
      codeIdentifiers: codeIdentifiersFromContext,
      keyFacts: keyFactsFromContext,
      contextWeakHint,
      previousSummaries,
      dayNumber: item.day,
      totalDays,
      item,
      usedConcepts: usedConcepts || [],  // ← concept memory
    });

    // ─────────────────────────────
    // PHASE 2: META (SAFE)
    // ─────────────────────────────

    let metaData = { importantNotes: [], summary: "", quiz: [] };

    try {
      if (typeof generateLessonMeta === "function") {
        const metaRaw = await retryWithBackoff(() => generateLessonMeta({
          context,
          searchTopic,
          objective,
          bloomLevel,
          quizBounds,
          profile,
          formulaNotes: formulaNotesFromContext,
          totalDays,
        }));
        const parsed = safeJSONParse(metaRaw);
        if (parsed) metaData = { ...metaData, ...parsed };
      } else {
        console.warn("[Meta] generateLessonMeta is not defined, skipping");
      }
    } catch (err) {
      console.warn("[Meta] failed:", err.message);
    }

    // ─────────────────────────────
    // NORMALIZE
    // ─────────────────────────────

    let data = normalizeLessonData(
      {
        content: lessonContent,
        importantNotes: metaData.importantNotes || [],
        summary:
          metaData.summary ||
          objective ||
          `Bài học về ${searchTopic}`,
        quiz: metaData.quiz || [],
      },
      objective,
      formulaNotesFromContext,
      searchTopic,
      quizBounds,
      practiceBias,
      { allowHeuristicFallback: false }
    );

    // ─────────────────────────────
    // QUIZ PIPELINE (SAFE)
    // ─────────────────────────────

    try {
      data.quiz = await runQuizPipeline({
        existingQuiz: data.quiz,
        context,
        searchTopic,
        objective,
        profile,
        quizBounds,
        formulaNotes: formulaNotesFromContext,
      });
    } catch (err) {
      console.warn("[Quiz] pipeline failed:", err.message);
    }

    // fallback nếu thiếu quiz
    if (!data.quiz || data.quiz.length < quizBounds.min) {
      data = normalizeLessonData(
        { ...data },
        objective,
        formulaNotesFromContext,
        searchTopic,
        quizBounds,
        practiceBias,
        { allowHeuristicFallback: true }
      );
    }

    data.usedChunkSignatures = currentChunkSigs;

    // ── CONCEPT EXTRACTION: lưu lại những gì vừa dạy ──
    const taughtConcepts = extractConcepts(data.content || "", searchTopic);
    data.newConcepts = taughtConcepts;  // trả về để planController merge vào usedConcepts

    return data;

  } catch (err) {
    console.error("[generateScientificLesson] Error:", err.message);

    return {
      content: "Nội dung đang được cập nhật...",
      importantNotes: [],
      summary: "Lỗi hệ thống AI",
      quiz: [],
      usedChunkSignatures: [],
      newConcepts: [],
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 🔍 HÀM 4: PHÂN TÍCH TÀI LIỆU NHANH (analyzeDocument)
//
// Mục đích: Đây là BƯỚC ĐẦU TIÊN trong quy trình tạo khóa học.
// Khi người dùng tải file lên và chọn số ngày → hàm này chạy ngay,
// trả về đề xuất sơ bộ để người dùng XEM TRƯỚC và xác nhận trước khi tạo thật.
//
// Tham số đầu vào:
//   - text            : Nội dung văn bản trích xuất (tối đa ~3500 ký tự đầu)
//   - rawLearningGoals: Mục tiêu học ({focus: 'theory'/'practice', depth: 'basic'/'deep'})
//   - userDays        : Số ngày học người dùng muốn (1-14)
//   - fileMetadata    : Thông tin tổng quan file (số từ, có bảng, có công thức...)
//
// Kết quả trả về gồm 2 phần:
//   {
//     analysis: { suggestedTitle, difficulty, summary }  ← AI phân tích nhanh
//     previewPlan: [{dayNumber, title, objective, bloomLevel, coveredSections}]  ← Khung N ngày
//   }
//
// ⚡ Lưu ý quan trọng: Hàm này CHỈ dùng 3500 ký tự ĐẦU của tài liệu để phân tích nhanh.
//    Không phải toàn bộ — đủ để ước lượng nhưng không tốn quá nhiều token AI.
// ─────────────────────────────────────────────────────────────────────────────
const analyzeDocument = async (text, rawLearningGoals = {}, userDays = 7, fileMetadata = null) => {
  const learningGoals = normalizeLearningGoals(rawLearningGoals);
  const wordCount = text.split(/\s+/).length;

  let requestedDays = parseInt(userDays) || 7;
  const finalDaysMaster = Math.min(DAYS_MAX, Math.max(DAYS_MIN, requestedDays));

  const metaContext = fileMetadata
    ? `THONG TIN: So tu: ${fileMetadata.wordCount}. Bang bieu: ${fileMetadata.tableCount > 0 ? fileMetadata.tableCount : "Khong"}. Cong thuc: ${fileMetadata.hasFormulas ? "Co" : "Khong"}. Do phuc tap: ${fileMetadata.estimatedComplexity}.`
    : "";

  const prompt = `Phan tich tai lieu (${wordCount} tu). ${metaContext}

BOI CANH NGUOI HOC:
${analyzeContextBlock(learningGoals)}

QUY TAC BAT BUOC:
- suggestedDays PHAI = ${finalDaysMaster}
- difficulty CHI DUOC: Easy | Medium | Hard
- summary: 1-2 cau, khong chung chung

{"suggestedTitle":"...","difficulty":"Medium","suggestedDays":${finalDaysMaster},"summary":"..."}`;

  let analysis = {};

  try {
    const response = await makeGroqRequest({
      messages: [
        { role: "system", content: "Chi tra ve JSON hop le." },
        { role: "user", content: prompt + "\n\nTEXT:\n" + text.substring(0, MAX_ANALYZE_TEXT) }
      ],
      model: MODEL_FAST,
      temperature: 0.1,
      maxTokens: 600,
      enforceJSON: true,
    });

    analysis = safeJSONParse(response) || {};

  } catch (err) {
    console.warn("[analyzeDocument] AI failed, fallback:", err.message);
    analysis = {};
  }

  // ─────────────────────────────
  // FIX-1: HARD VALIDATION + FALLBACK
  // ─────────────────────────────

  const normalizeDifficulty = (d) => {
    if (!d) return null;
    const val = String(d).toLowerCase();
    if (val.includes("easy")) return "Easy";
    if (val.includes("hard")) return "Hard";
    return "Medium";
  };

  let suggestedTitle = normalizeSpace(analysis.suggestedTitle || "");
  let difficulty = normalizeDifficulty(analysis.difficulty);
  let summary = normalizeSpace(analysis.summary || "");

  // Fix title nếu rỗng / generic
  if (!suggestedTitle || suggestedTitle.length < 5) {
    suggestedTitle = extractTitleFromText(text) || "Lo trinh hoc tu tai lieu";
  }

  // Fix difficulty nếu thiếu
  if (!difficulty) {
    difficulty =
      learningGoals.depth === "deep"
        ? "Hard"
        : wordCount > 4000
          ? "Hard"
          : wordCount < 1200
            ? "Easy"
            : "Medium";
  }

  // Fix summary nếu generic
  if (
    !summary ||
    summary.length < 20 ||
    /(tong quan|gioi thieu|noi dung tai lieu|overview)/i.test(summary)
  ) {
    summary = `Tai lieu tap trung vao cac noi dung chinh cua "${suggestedTitle}", duoc chia thanh ${finalDaysMaster} ngay hoc theo lo trinh logic.`;
  }

  const finalAnalysis = {
    suggestedTitle,
    difficulty,
    suggestedDays: finalDaysMaster,
    summary,
    learningGoals,
  };

  // ─────────────────────────────
  // FIX-2: SYLLABUS SAFE FALLBACK
  // ─────────────────────────────

  let preview;

  try {
    preview = await generateSyllabus(text, finalDaysMaster, learningGoals);

    // validate output
    if (!preview || !Array.isArray(preview.syllabus) || preview.syllabus.length === 0) {
      throw new Error("Invalid syllabus structure");
    }

  } catch (err) {
    console.warn("[generateSyllabus] fallback:", err.message);

    preview = {
      title: suggestedTitle,
      syllabus: buildFallbackPreviewPlan(text, finalDaysMaster),
    };
  }

  // ─────────────────────────────
  // FIX-3: FINAL SAFETY CHECK
  // ─────────────────────────────

  const safeSyllabus = (preview.syllabus || []).map((item, i) => ({
    dayNumber: i + 1,
    title: item.title || `Chu de ngay ${i + 1}`,
    objective: item.objective || `Nam duoc noi dung ngay ${i + 1}`,
    bloomLevel: item.bloomLevel || getBloomLevel(i, finalDaysMaster).label,
    coveredSections: Array.isArray(item.coveredSections) && item.coveredSections.length > 0
      ? item.coveredSections
      : [`Noi dung ngay ${i + 1}`],
  }));

  return {
    analysis: finalAnalysis,
    previewPlan: safeSyllabus,
  };
};
// ─────────────────────────────────────────────
// NORMALIZE TAG
// ─────────────────────────────────────────────

const normalizeTag = (tag = "") =>
  String(tag)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "") // bỏ ký tự đặc biệt
    .trim()
    .replace(/\s+/g, "_");


// ─────────────────────────────────────────────
// MODULE EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  generateSyllabus,
  processAndStoreDocument,
  generateScientificLesson,
  analyzeDocument,
  safeJSONParse,
  retryWithBackoff,
  makeGroqRequest,
  makeGroqPlainRequest,
  normalizeQuizBatch,
  scoreQuizItem,
  extractFormulaLikeNotes,
  getBloomLevel,
  selectDiverseChunks,
  generateHyDE,
  normalizeTag,
  validateScopeCompliance,
  checkContentDuplication,
  filterChunksByScore,
};