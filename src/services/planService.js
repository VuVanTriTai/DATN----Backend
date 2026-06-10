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
const mongoose = require("mongoose");

const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Nạp danh sách các khóa Groq từ file .env
const groqKeys = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5
].filter(Boolean);

let currentGroqKeyIndex = 0;
let groq = new Groq({ apiKey: groqKeys[0] || process.env.GROQ_API_KEY });

const rotateGroqClient = () => {
  if (groqKeys.length <= 1) return;
  currentGroqKeyIndex = (currentGroqKeyIndex + 1) % groqKeys.length;
  console.log(`[Groq Rotation] Xoay vòng sang Groq API Key #${currentGroqKeyIndex + 1}: ${groqKeys[currentGroqKeyIndex].slice(0, 8)}...`);
  groq = new Groq({ apiKey: groqKeys[currentGroqKeyIndex] });
};

// Khởi tạo Gemini client làm Ultimate Fallback
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// ─────────────────────────────
// SERVICES
// ─────────────────────────────
const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks, searchChunksBySection } = require("./vectorSearchService");
// ⚠️ getLearningMode đã bị xóa: UI mới không còn dùng REMEDIAL/NORMAL/ADVANCED
// Persona giờ được xác định trực tiếp từ profile.depth (basic/deep)
const { generateLessonMeta } = require('./aiService'); // Hoặc đường dẫn tương ứng
const { validateDocument } = require('./docValidationService');
// ─────────────────────────────
// MODELS
// ─────────────────────────────
const Chunk = require("../models/Chunk");

// ─────────────────────────────
// TEXT PROCESSING
// ─────────────────────────────
const { cleanText, fixOcrGluedWords } = require("../utils/cleanText");

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
const GROQ_MAX_RPM_RETRIES = Number(process.env.GROQ_MAX_RPM_RETRIES || 1);
const GROQ_RPM_WAIT_MS = Number(process.env.GROQ_RPM_WAIT_MS || 5000);
const GROQ_REQUEST_TIMEOUT_MS = Number(process.env.GROQ_REQUEST_TIMEOUT_MS || 45000);
const COURSE_LESSON_DELAY_MS = Number(process.env.COURSE_LESSON_DELAY_MS || 0);
const DEBUG_CHUNKS_PATH = path.join(__dirname, "../debug/debug_chunks_saved.json");



// AI FEATURES (OPTIONAL SAFE LOAD)
// ─────────────────────────────
let aiChunkText;
let detectMissingContent;

try {
  ({ aiChunkText } = require("./aiChunkService"));
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

// [Chức năng chuyển model đã bị loại bỏ theo yêu cầu để tránh lặp các model Groq lỗi và fallback thẳng sang Gemini]

// Models hỗ trợ response_format: { type: 'json_object' }
// gemma2-9b-it KHÔNG nằm trong list này vì không hỗ trợ JSON mode
const GROQ_JSON_MODELS = new Set([
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "llama3-8b-8192",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
]);

const MAX_CONTEXT_CHARS = 9500;
const MAX_SYLLABUS_TEXT = 8000;  // Tăng lên 35000 để bao phủ trọn vẹn tài liệu lớn nhiều chương khi lập syllabus

//const MAX_ANALYZE_TEXT   = 5000;

const CHUNK_SEARCH_K = 12;
const CHUNK_USE_K = 8;
const EMBEDDING_STAGGER_MS = Number(process.env.EMBEDDING_STAGGER_MS || 400);
const CHUNK_SCORE_THRESHOLD = 0.30; // ✅ FIX: giảm ngưỡng để giữ lại chunk có code



// 🔥 chunk control (quan trọng cho RAG)
const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_WORDS = 40;

// ─────────────────────────────
// LESSON BUDGET
// ─────────────────────────────
// targetWords: hướng dẫn AI viết bao nhiêu từ/bài — để bài đủ sâu, không quá ngắn
const LESSON_BUDGET_SHORT = { contentTokens: 2800, metaTokens: 1800, targetWords: "600-900", useSmarter: true };
const LESSON_BUDGET_MEDIUM = { contentTokens: 2400, metaTokens: 1600, targetWords: "500-750", useSmarter: false };
const LESSON_BUDGET_NORMAL = { contentTokens: 2200, metaTokens: 1600, targetWords: "450-700", useSmarter: false };

const getDynamicLessonBudget = (totalDays) => {
  if (totalDays <= 3) return LESSON_BUDGET_SHORT;
  if (totalDays <= 6) return LESSON_BUDGET_MEDIUM;
  return LESSON_BUDGET_NORMAL;
};

const HARD_CAP_FAST = 3000;
const HARD_CAP_SMART = 5000;

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
const callGeminiFallback = async (buildParams) => {
  if (!genAI) {
    console.error("[Gemini Fallback] Gemini API Key chưa được cấu hình.");
    return null;
  }

  console.log("🚀 [Gemini Fallback] Kích hoạt Gemini 1.5 Flash làm Ultimate Fallback...");
  try {
    const sampleParams = buildParams("llama-3.3-70b-versatile", 0);
    const messages = sampleParams.messages || [];

    let systemInstruction = "";
    let userPrompt = "";

    messages.forEach(msg => {
      if (msg.role === "system") {
        systemInstruction += msg.content + "\n";
      } else {
        userPrompt += `${msg.role}: ${msg.content}\n`;
      }
    });

    const modelInstance = genAI.getGenerativeModel({
      model: "gemini-flash-latest",
      systemInstruction: systemInstruction.trim() || undefined,
    });

    const temperature = sampleParams.temperature !== undefined ? sampleParams.temperature : 0.2;
    const enforceJSON = !!sampleParams.response_format ||
      messages.some((msg) => /json/i.test(String(msg?.content || "")));

    const requestedTokens = sampleParams.max_tokens || 2048;
    const safeTokens = Math.min(8192, Math.max(requestedTokens, 4096));

    const generationConfig = {
      temperature,
      maxOutputTokens: safeTokens,
      responseMimeType: enforceJSON ? "application/json" : "text/plain",
    };

    const result = await modelInstance.generateContent({
      contents: [{ role: "user", parts: [{ text: userPrompt.trim() }] }],
      generationConfig,
    });

    let resText = result.response.text();
    if (!resText) throw new Error("Gemini response is empty");

    resText = resText.trim();

    // Chỉ strip preamble/postamble nếu request là JSON
    // Plain text request (bài giảng Markdown) KHÔNG strip vì không có { hay [
    if (enforceJSON) {
      const jsonStartBrace = resText.indexOf('{');
      const jsonStartBracket = resText.indexOf('[');
      const jsonStart = [jsonStartBrace, jsonStartBracket]
        .filter(i => i >= 0)
        .reduce((min, i) => Math.min(min, i), Infinity);

      if (jsonStart > 0 && jsonStart !== Infinity) {
        const preamble = resText.slice(0, jsonStart);
        // Strip CHỈ khi preamble là text thuần (không chứa ký tự JSON)
        if (!/[{[\]}":]/.test(preamble)) {
          console.warn(`[Gemini] Strip preamble (${jsonStart} chars):`, preamble.slice(0, 60));
          resText = resText.slice(jsonStart);
        }
      }

      const jsonEndBrace = resText.lastIndexOf('}');
      const jsonEndBracket = resText.lastIndexOf(']');
      const jsonEnd = Math.max(jsonEndBrace, jsonEndBracket);
      if (jsonEnd > 0 && jsonEnd < resText.length - 1) {
        const postamble = resText.slice(jsonEnd + 1);
        if (!/[{[\]}":]/.test(postamble)) {
          resText = resText.slice(0, jsonEnd + 1);
        }
      }

      if (!resText) throw new Error("Gemini response empty after strip");
    }

    console.log("✅ [Gemini Fallback] Sinh nội dung thành công từ Gemini!");
    return resText;
  } catch (geminiErr) {
    console.error("❌ [Gemini Fallback] Lỗi khi gọi Gemini API:", geminiErr.message);
    throw geminiErr;
  }
};
const callGroqWithFallback = async (buildParams, startModel = MODEL_FAST) => {
  let lastErr;
  const maxKeyAttempts = Math.max(1, groqKeys.length);

  for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
    try {
      const activeModel = startModel;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const params = buildParams(activeModel, attempt);

          // ✅ FIX: Groq SDK không nhận field "timeout" → xóa trước khi gọi
          delete params.timeout;

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
          const isModelCapErr = /response_format|not support|unsupported|does not support/i.test(msg);

          if (isTPD) {
            console.error(`[Groq] ${activeModel} hết TPD trên Key #${currentGroqKeyIndex + 1}.`);
            if (groqKeys.length > 1 && keyAttempt < maxKeyAttempts - 1) {
              rotateGroqClient();
              throw new Error("ROTATE_KEY");
            }
            break;
          }

          if (isModelCapErr) {
            console.warn(`[Groq] "${activeModel}" không hỗ trợ tính năng. Chuyển sang Gemini.`);
            break;
          }

          if (isRPM && attempt < GROQ_MAX_RPM_RETRIES) {
            const wait = Math.min(parse429WaitMs(msg) || GROQ_RPM_WAIT_MS, GROQ_RPM_WAIT_MS);
            console.warn(`[Groq] "${activeModel}" RPM limit. Đợi ${wait / 1000}s rồi thử lại...`);
            await sleep(wait);
            continue;
          }

          if (isRPM) {
            console.warn(`[Groq] "${activeModel}" vẫn bị RPM limit. Chuyển sang Gemini.`);
            break;
          }

          if (/timeout|json|parse|empty/i.test(msg) && attempt < 2) {
            await sleep(2000 + 1000 * attempt);
            continue;
          }

          if (is429 && !isTPD && !isRPM && attempt < 1) {
            if (groqKeys.length > 1 && keyAttempt < maxKeyAttempts - 1) {
              rotateGroqClient();
              throw new Error("ROTATE_KEY");
            }
            await sleep(5000);
            continue;
          }

          if (!is429 && !/timeout|json|parse|empty/i.test(msg) && status >= 400) {
            console.warn(`[Groq] "${activeModel}" lỗi ${status}: ${msg.slice(0, 80)}. Chuyển sang Gemini.`);
            break;
          }

          break;
        }
      }
      break;
    } catch (keyErr) {
      if (keyErr.message === "ROTATE_KEY") {
        continue;
      }
      throw keyErr;
    }
  }

  console.error('[Groq] Yêu cầu thất bại hoặc hết quota TPD. Chuyển sang Gemini Fallback.');

  if (genAI) {
    try {
      return await callGeminiFallback(buildParams);
    } catch (geminiErr) {
      console.error('[Ultimate Fallback] Gemini thất bại:', geminiErr.message);
    }
  }

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
  model = MODEL_SMART,
  temperature = 0.1,
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
    return {
      messages,
      model: activeModel,
      temperature,
      max_tokens: safeMax,
    };
  }, model);
};




const makeGroqPlainRequest = async ({
  messages,
  model = MODEL_FAST,
  temperature = 0.0,
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

const extractBalancedJSON = (input) => {
  const source = String(input || "");
  const objectStart = source.indexOf("{");
  const arrayStart = source.indexOf("[");
  const startCandidates = [objectStart, arrayStart].filter((idx) => idx >= 0);
  if (!startCandidates.length) return source.trim();

  const start = Math.min(...startCandidates);
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const open = stack[stack.length - 1];
      const matches = (open === "{" && ch === "}") || (open === "[" && ch === "]");
      if (!matches) continue;
      stack.pop();
      if (stack.length === 0) return source.slice(start, i + 1).trim();
    }
  }

  return source.slice(start).trim();
};

const escapeRawNewlinesInJsonStrings = (json) => {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of String(json || "")) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === "\"") {
        out += ch;
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch !== "\r") {
        out += ch;
      }
      continue;
    }

    out += ch;
    if (ch === "\"") inString = true;
  }

  return out;
};

const safeJSONParse = (text) => {
  if (!text || typeof text !== "string") {
    throw new Error("Empty AI response");
  }

  let cleaned = text
    .replace(/^\uFEFF/, "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .trim();

  // ✅ FIX: strip preamble text trước JSON (Gemini hay thêm "Here is...", "Sure!",...)
  // Tìm vị trí { hoặc [ đầu tiên và cắt từ đó
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const jsonStart = [firstBrace, firstBracket]
    .filter(i => i >= 0)
    .reduce((min, i) => Math.min(min, i), Infinity);

  if (jsonStart > 0 && jsonStart !== Infinity) {
    const preamble = cleaned.slice(0, jsonStart);
    // Chỉ strip nếu phần trước là text thuần (không phải JSON hợp lệ bị hỏng)
    if (!/[{[\]}]/.test(preamble)) {
      console.warn(`[safeJSONParse] Strip preamble (${jsonStart} chars):`, preamble.slice(0, 60));
      cleaned = cleaned.slice(jsonStart);
    }
  }

  cleaned = extractBalancedJSON(cleaned);

  // Try parse lần 1
  try {
    return JSON.parse(cleaned);
  } catch (e1) { }

  try {
    return JSON.parse(escapeRawNewlinesInJsonStrings(cleaned));
  } catch (_) { }

  // Fix lỗi comma / newline
  try {
    const fixed = escapeRawNewlinesInJsonStrings(cleaned)
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
 * Cắt context thông minh: giữ head + tail thay vì cắt thô.
 * Pattern từ embeddingService — tránh mất định nghĩa/ví dụ ở cuối chunk.
 *
 * @param {string} text     - Văn bản cần cắt
 * @param {number} maxChars - Giới hạn ký tự tối đa
 * @param {number} tailSize - Số ký tự đuôi luôn được giữ lại (mặc định 600)
 * @returns {string}
 */
const smartTruncateContext = (text, maxChars, tailSize = 600) => {
  const t = String(text || "").trim();
  if (t.length <= maxChars) return t;

  const headSize = maxChars - tailSize;
  let head = t.slice(0, headSize);
  const sepIdx = head.lastIndexOf("\n---\n");
  const paraIdx = head.lastIndexOf("\n\n");
  const spaceIdx = head.lastIndexOf(" ");

  const cutAt = sepIdx > headSize * 0.6 ? sepIdx
    : paraIdx > headSize * 0.6 ? paraIdx
    : spaceIdx > headSize * 0.4 ? spaceIdx
    : headSize;

  head = head.slice(0, cutAt).trimEnd();

  // Giữ tail từ ranh giới đoạn gần nhất
  let tail = t.slice(-tailSize);
  const tailSep = tail.indexOf("\n---\n");
  const tailPara = tail.indexOf("\n\n");
  const tailStart = tailSep >= 0 && tailSep < tailPara ? tailSep
    : tailPara >= 0 ? tailPara
    : 0;

  tail = tail.slice(tailStart).trimStart();

  return `${head}\n\n[...truncated...]\n\n${tail}`;
};

/**
 * Làm sạch section name từ chunk — loại bỏ section names là code/OCR rác.
 * Dùng trong processAndStoreDocument() khi lưu chunk.section vào DB.
 *
 * @param {string} section
 * @returns {string}
 */
const sanitizeSectionName = (section) => {
  if (!section || typeof section !== "string") return "";

  let s = section.trim().replace(/^\*{1,3}/, "").replace(/\*{1,3}$/, "").trim();

  // ✅ FIX: Strip ngoặc vuông bọc số mục TRƯỚC khi kiểm tra ký tự đặc biệt
  // Ví dụ: "[1.2] Stored Procedure" → "1.2 Stored Procedure"
  s = s.replace(/^\[(\d+(?:\.\d+)+)\]\s*/, "$1 ").trim();

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
    // ── Bỏ qua separators ───────────────────────────────────────────────
    if (/^[-=─═]{2,}$/.test(line)) continue;
    if (/^\[Context:/i.test(line)) continue;
    if (/^\[BẢNG/i.test(line)) continue;

    // ── Bỏ qua prompt leakage ────────────────────────────────────────────
    if (/QUY TẮC BẮT BUỘC|YÊU CẦU OUTPUT|THÔNG TIN BÀI|CHẾ ĐỘ:/i.test(line)) continue;
    if (/^(BẮT BUỘC|NGHIÊM CẤM|FORBIDDEN|CẤM TUYỆT ĐỐI)/i.test(line)) continue;
    if (/^(⚠️|❗|🎯|⛔|✅|🚫)/.test(line)) continue; // emoji prompt markers

    // ── Bỏ qua URL / path fragment ──────────────────────────────────────
    if (/^https?:\/\//i.test(line)) continue;
    if (/^[\w./%-]+\.(asp|php|html?|aspx|jsp)\b/i.test(line)) continue;
    if (/^[\w-]+\/[\w-]+\//.test(line)) continue;

    // ── Bỏ qua code fragment bị cắt ─────────────────────────────────────
    if (/^[,+;/\\()\[\]{}|]/.test(line)) continue;
    if (/[+,]$/.test(line)) continue;

    // ── Bỏ qua dòng quá ngắn / OCR noise ────────────────────────────────
    if (line.length < 20) continue;
    if (/^[\d\s\-./]+$/.test(line)) continue;
    const letterCount = (line.match(/[a-zA-ZÀ-ỹ]/g) || []).length;
    if (letterCount < 6) continue;

    // ── Bỏ qua bullet bị cắt giữa câu ──────────────────────────────────
    if (/^[◦•]\s+/.test(line)) {
      const content = line.replace(/^[◦•]\s+/, "").trim();
      if (!/[.!?;:…]$/.test(content) && content.length < 80) continue;
    }

    // ────────────────────────────────────────────────────────────────────
    // DETECT NỘI DUNG CÓ GIÁ TRỊ — ĐA CHỦ ĐỀ
    // ────────────────────────────────────────────────────────────────────

    // 1. Toán học / công thức (domain: math, physics, finance, ...)
    const hasMeaningfulMath =
      /[=+\-*/^√∑∏≤≥≈%]/.test(line) &&
      /[a-zA-ZÀ-ỹ]{3,}/.test(line);

    // 2. Định nghĩa / khái niệm (domain-agnostic)
    const hasDef =
      /(định nghĩa|khái niệm|công thức|nguyên lý|nguyên tắc|quy tắc|quy luật|định lý|hệ quả|tính chất|đặc điểm|phân loại|theorem|lemma|property|axiom|rule|principle|formula|definition)/i.test(line);

    // 3. Liệt kê có cấu trúc: "X bao gồm:", "X gồm:", "X là:", "Có N loại:"
    const hasEnumeration =
      /(bao gồm|gồm có|gồm:|bao gồm:|có \d+ loại|có \d+ bước|có \d+ trường hợp|phân thành|chia thành)/i.test(line);

    // 4. Kỹ thuật / quy trình (domain: IT, engineering, medicine, ...)
    const hasProcess =
      /(bước \d+|step \d+|giai đoạn|quy trình|thủ tục|cách thức|phương pháp|algorithm|workflow)/i.test(line);

    // 5. Lưu ý / cảnh báo quan trọng (học thuật)
    const hasNote =
      /^(lưu ý|chú ý|quan trọng|note:|warning:|important:|nhớ rằng|cần nhớ)/i.test(line);

    // 6. Bullet có nội dung đầy đủ (dòng bắt đầu bằng - hoặc số, đủ dài)
    const isCompleteBullet =
      /^[-*•]\s+.{40,}/.test(line) || /^\d+[.)]\s+.{30,}/.test(line);

    const tooNoisy = line.length > 280;
    const isPromptLike =
      /KHÔNG ĐƯỢC|BẮT BUỘC|PHẢI|TUYỆT ĐỐI|CHỈ DÙNG|forbidden|mandatory/i.test(line);

    if (
      !tooNoisy &&
      !isPromptLike &&
      (hasMeaningfulMath || hasDef || hasEnumeration || hasProcess || hasNote || isCompleteBullet)
    ) {
      results.push(line.length > 200 ? line.slice(0, 200) + "..." : line);
    }
  }

  return [...new Set(results)].slice(0, 8);
};

// ─────────────────────────────────────────────
// IMPORT NOTES SCOPE FILTER — domain-agnostic
// Lọc ghi chú theo phạm vi ngày học hiện tại.
//
// Strategy:
//   1. Nếu coveredSections rỗng → giữ nguyên
//   2. Nếu tài liệu có số mục X.Y → lọc theo số mục
//   3. Nếu không có số mục (tài liệu tự nhiên) → lọc bằng keyword match
//      từ tiêu đề section trong coveredSections
// ─────────────────────────────────────────────
const filterNotesByScope = (notes, coveredSections = []) => {
  if (!Array.isArray(notes) || notes.length === 0) return notes;
  if (!Array.isArray(coveredSections) || coveredSections.length === 0) return notes;

  // ── Case A: tài liệu có số mục X.Y ──
  const allowedNums = new Set(
    coveredSections
      .map(s => (String(s).match(/^(\d+\.\d+)/) || [])[1])
      .filter(Boolean)
  );

  if (allowedNums.size > 0) {
    return notes.filter(note => {
      const s = String(note || "");
      const numsInNote = (s.match(/\b(\d+\.\d+)\b/g) || []);
      if (numsInNote.length === 0) return true; // ghi chú tổng quát → giữ
      const hasOutOfScope = numsInNote.some(n => !allowedNums.has(n));
      return !hasOutOfScope;
    });
  }

  // ── Case B: tài liệu không đánh số → lọc bằng keyword ──
  // Trích từ khóa ngắn (2-4 từ đầu) từ mỗi coveredSection
  const allowedKeywords = coveredSections
    .map(s => normalizeText(String(s)).slice(0, 40))
    .filter(k => k.length >= 4);

  if (!allowedKeywords.length) return notes;

  return notes.filter(note => {
    const noteNorm = normalizeText(String(note || ""));
    // Giữ lại nếu note khớp bất kỳ keyword nào từ danh sách sections hôm nay
    return allowedKeywords.some(k => noteNorm.includes(k.slice(0, 20)));
  });
};

// ─────────────────────────────────────────────
// EXTRACT CONTEXT TERMS — domain-agnostic
// Trích thuật ngữ, tên riêng, ký hiệu từ tài liệu (mọi lĩnh vực)
// ─────────────────────────────────────────────
const CONTEXT_TERM_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "các", "của", "cho",
  "với", "trong", "khi", "này", "được", "theo", "như", "một", "những",
  "bài", "phần", "chương", "mục", "ngày", "ví", "dụ",
]);

const extractContextTerms = (text) => {
  let src = String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "");

  const found = new Set();
  const add = (term) => {
    const t = String(term || "").trim();
    if (t.length < 2 || t.length > 50) return;
    if (CONTEXT_TERM_STOPWORDS.has(t.toLowerCase())) return;
    found.add(t);
  };

  // Thuật ngữ trong ngoặc kép / nháy
  const quoted = src.match(/"([^"]{2,45})"|'([^']{2,45})'|«([^»]{2,45})»/g) || [];
  quoted.forEach((q) => add(q.replace(/^["'«]|["'»]$/g, "")));

  // Nhãn đánh số: "1.2 Tên khái niệm"
  const numbered = src.match(/\b\d+(?:\.\d+)+\s+[A-ZÀ-Ỹa-zà-ỹ][^\n.]{2,40}/g) || [];
  numbered.forEach((l) => add(l.replace(/^\d+(?:\.\d+)+\s+/, "").trim()));

  // Cụm tên riêng / thuật ngữ (PascalCase, snake_case, có dấu tiếng Việt)
  const terms = src.match(
    /\b[A-ZÀ-Ỹ][A-Za-zÀ-ỹ0-9]*(?:[A-ZÀ-ỹ][A-Za-zÀ-ỹ0-9]*)+\b|\b[A-Za-zÀ-ỹ]{2,}(?:_[A-Za-zÀ-ỹ0-9]+)+\b|\b[A-ZÀ-Ỹ][A-ZÀ-Ỹ0-9]{1,}\b/g
  ) || [];
  terms.forEach(add);

  // Ký hiệu toán / khoa học phổ biến
  const symbols = src.match(/\b[A-Z]{1,3}\d*(?:[₀-₉⁰-⁹]+)?\b|[α-ωΑ-Ω][₀-₉⁰-⁹]*/g) || [];
  symbols.forEach(add);

  return [...found].slice(0, 15);
};

// Alias giữ tương thích nội bộ
const extractCodeIdentifiers = extractContextTerms;

// ─────────────────────────────
// EXTRACT KEY FACTS FROM CONTEXT — domain-agnostic
// Trích xuất sự kiện/phân loại quan trọng từ bất kỳ loại tài liệu nào
// để inject vào prompt, bắt buộc AI phải cover đầy đủ
// ─────────────────────────────
const extractKeyFacts = (text) => {
  // Decode HTML entities (chunks cũ trong DB có thể có &lt; &gt;)
  const src = String(text || "")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, '');
  const facts = [];

  // 1. Các dòng liệt kê có đánh số: "1. ...", "2. ..."
  const numberedLines = src.match(/^\s*\d+[.)\-]\s+.{10,}/gm) || [];
  numberedLines.forEach(l => facts.push(l.trim()));

  // 2. Phân loại có số lượng (mọi chủ đề): loại, dạng, nhóm, kiểu, bước, giai đoạn...
  const classificationLines = src.match(
    /.{5,}(?:loại|trường hợp|nhóm|kiểu|dạng|cách|mức|bước|giai đoạn|thành phần|yếu tố|điều kiện|nguyên tắc|quy tắc)\s*[:]\.?.{5,}/gi
  ) || [];
  classificationLines.forEach(l => facts.push(l.trim().slice(0, 200)));

  // 3. Định nghĩa rõ ràng (tiếng Việt và tiếng Anh)
  const defLines = src.match(
    /.{5,}(?:là một|là tập|là quá trình|được định nghĩa|được hiểu là|is defined as|refers to|is a type of|means that).{10,}/gi
  ) || [];
  defLines.forEach(l => facts.push(l.trim().slice(0, 200)));

  // 4. Công thức / quan hệ định lượng (toán, khoa học, kinh tế...)
  const formulaLines = src.match(
    /^.{5,}[=≈≤≥→←∝∑∏∫].{5,}$/gm
  ) || [];
  formulaLines.slice(0, 4).forEach(l => facts.push(l.trim().slice(0, 200)));

  // 5. Bullet points quan trọng (mọi ký hiệu bullet)
  const bullets = src.match(/^\s*[◦•*\-▸►▷] {1,}[A-ZÀ-ỹ].{15,}/gm) || [];
  bullets.slice(0, 8).forEach(l => facts.push(l.trim()));

  // 6. Heading tiêu đề cấp 2, 3 — nội dung phải cover (trích từ context)
  const headings = src.match(/^#{2,3}\s+.{5,}/gm) || [];
  headings.slice(0, 6).forEach(l => facts.push(l.replace(/^#+\s*/, '').trim()));

  // Loại bỏ trùng lặp và giới hạn
  return [...new Set(facts)]
    .filter(f => f.length >= 10)
    .slice(0, 15);
};

// ─────────────────────────────────────────────────────────
// POST-GENERATION: XÓA KHỐI VÍ DỤ CÓ PLACEHOLDER BỊA (domain-agnostic)
// Áp dụng cho mọi khối ``` (mã, công thức, pseudo-code, bảng text...)
// ─────────────────────────────────────────────────────────
const PLACEHOLDER_PATTERNS = [
  /\bparam\d*\b/i,
  /\bexample\b/i,
  /\bten_?cua_?ban\b/i,
  /\btenbang\b/i,
  /\byour_?name\b/i,
  /\bmy_?(function|table|procedure|class|variable)\b/i,
  /\b<tên[^>]*>/i,
  /\b\.\.\.\b/,
  /_{3,}/,
  /\bxxx+\b/i,
  /\bplaceholder\b/i,
  /\bgiá\s*trả\s*về\b/i,
  /\btên\s*(của\s*)?(hàm|bảng|biến|class)\b/i,
];

const stripInvalidCodeBlocks = (content, contextText) => {
  if (!content || !contextText) return content;

  const ctxNorm = normalizeText(contextText);
  const CODE_BLOCK_RE = /```[\w]*\n([\s\S]*?)```/g;
  let result = content;
  let match;
  const toRemove = [];

  while ((match = CODE_BLOCK_RE.exec(content)) !== null) {
    const blockFull = match[0];
    const blockCode = match[1];

    const placeholderHits = PLACEHOLDER_PATTERNS.filter((re) => re.test(blockCode)).length;
    // Ngưỡng 3: cần ít nhất 3 dấu hiệu placeholder mới xóa (trước là 2, dễ xóa oan ví dụ hợp lệ)
    if (placeholderHits < 3) continue;

    // Giữ block nếu phần lớn nội dung đã có trong context (trích từ tài liệu)
    const blockNorm = normalizeText(blockCode);
    const overlapWords = blockNorm.split(/\s+/).filter((w) => w.length > 4 && ctxNorm.includes(w));
    if (overlapWords.length >= 3) continue;

    console.warn(`[ExampleGuard] Xóa khối ví dụ có placeholder bịa (${placeholderHits} dấu hiệu)`);
    toRemove.push({ full: blockFull });
  }

  for (const { full } of toRemove) {
    result = result.replace(full, "> ⚠️ *Ví dụ bị lược bỏ vì chứa nội dung giả lập không có trong tài liệu.*");
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
// ─────────────────────────────
// DOCUMENT OUTLINE (IMPROVED)
// ─────────────────────────────
const extractDocumentOutline = (text) => {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const headings = [];

  const cleanHeadingOcr = (h) => fixOcrGluedWords(h || "").trim();

  const trimHeadingToPhrase = (raw, hasNumber = false) => {
    if (hasNumber) return raw.slice(0, 100);

    if (!raw || raw.length <= 40) return raw;

    const parenIdx = raw.indexOf('(', 35);
    if (parenIdx > 35 && parenIdx < raw.length - 1) {
      return raw.slice(0, parenIdx).trim();
    }

    const words = raw.split(/\s+/);
    let shortRun = 0;
    let cutPos = -1;
    let charCount = 0;
    for (let i = 0; i < words.length; i++) {
      charCount += words[i].length + 1;
      if (charCount > 40) {
        if (words[i].length <= 5) {
          shortRun++;
          if (shortRun >= 3) {
            cutPos = i - shortRun + 1;
            break;
          }
        } else {
          shortRun = 0;
        }
      }
    }
    if (cutPos > 2) return words.slice(0, cutPos).join(' ').trim();

    return raw.slice(0, 80).trim();
  };

  for (const line of lines) {
    // Markdown heading
    const md = line.match(/^(#{1,3})\s+(.+)/);
    if (md) {
      const raw = md[2].replace(/[*_`]/g, "");
      const hasNum = /\d+\.\d+/.test(raw);
      const cleaned = cleanHeadingOcr(raw);

      if (md[1] === '#' && !hasNum) continue;

      headings.push(trimHeadingToPhrase(cleaned, hasNum).slice(0, 100));
      continue;
    }

    // Numbered sections
    // Numbered sections
    const stripped = line.replace(/^[*_]{1,3}/, "").replace(/[*_]{1,3}$/, "").trim();
    const num = stripped.match(/^(\d+(?:\.\d+)*)\s+(.{3,80})/);
    if (num) {
      const sectionNum = num[1];
      const titleRaw = cleanHeadingOcr(num[2].replace(/[*_`]/g, ""));

      const hasSubSection = sectionNum.includes('.');
      if (!hasSubSection) continue;

      const fullHeading = `${sectionNum} ${trimHeadingToPhrase(titleRaw, true)}`;
      headings.push(fullHeading.slice(0, 100));
      continue;
    }

    // Chapter keywords — chỉ lấy nếu có số mục X.Y đi kèm
    // FIX 3: Bỏ qua "Chương IV ...", "Chapter 1 ...", "Phần A ..." không có X.Y
    // Tránh tiêu đề tổng quát lọt vào outline rồi trở thành title ngày 1
    if (/^(chương|chapter|phần|section|bài|unit|module)\s+/i.test(line)) {
      const hasNum = /\d+\.\d+/.test(line);
      if (!hasNum) continue; // bỏ qua heading cấp chương không có số mục con
      headings.push(trimHeadingToPhrase(cleanHeadingOcr(line), true).slice(0, 100));
    }
  }

  const cleanHeadings = [...new Set(headings)].filter((h) => {
    if (/(?:^|\s)\w\s+\w\s+\w\s+\w/.test(h)) return false;
    if (/^\d+[/\\]\d+$/.test(h.trim())) return false;
    if (/^[\d\s,.]+$/.test(h.trim())) return false;
    if (!/[A-Za-zÀ-ỹ]{2,}/.test(h)) return false;

    // FIX 4: Loại bỏ heading là tên chương/tài liệu tổng quát không có số mục X.Y
    // Domain-agnostic: áp dụng cho Luật, Y học, Kinh tế, Lịch sử, Lập trình...
    const hasSubSectionNum = /\d+\.\d+/.test(h);
    const isChapterLevel = /^(chương|chapter|phần|section|bài|unit|module)\s+/i.test(h);
    if (isChapterLevel && !hasSubSectionNum) return false;

    return true;
  });

  return cleanHeadings.slice(0, 60);
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

  // ── CHECK 3: phát hiện số section lạc chỗ ──
  // FIX: Chỉ bắt số mục ở đầu dòng heading Markdown (## 2.3 Tiêu đề)
  // Tránh bắt sub-number như "7.1" từ bên trong "1.7.1 Định nghĩa"
  const allowedNums = new Set(
    coveredSections
      .map(s => (s.match(/^(\d+\.\d+)/) || [])[1])
      .filter(Boolean)
  );

  if (allowedNums.size > 0) {
    // Chỉ match số mục xuất hiện ở đầu dòng heading: "## 2.3 Tiêu đề" hoặc "### 2.3 Tiêu đề"
    // KHÔNG match "1.7.1" hay số mục nằm giữa câu văn
    const foundNums = [
      ...content.matchAll(/^#{1,4}\s+(\d+\.\d+)(?!\.\d)\b/gm)
    ].map(m => m[1]);

    const outOfScope = [...new Set(foundNums)].filter(n => {
      // Bỏ qua nếu n là con trực tiếp của một allowed num (1.7 → cho phép 1.7.x)
      if (allowedNums.has(n)) return false;
      for (const a of allowedNums) {
        if (n.startsWith(`${a}.`)) return false;
      }
      return true;
    });

    if (outOfScope.length > 0) {
      violations.push(
        `⚠️ Nội dung có mục ngoài phạm vi: ${outOfScope.join(", ")} (chỉ được phép: ${[...allowedNums].join(", ")})`
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
    // Cải tiến: so sánh với cả snippet nội dung thực tế (không chỉ title+summary)
    const refParts = [
      prev.title || "",
      prev.summary || "",
      prev.contentSnippet || ""  // snippet 300 từ đầu bài cũ
    ];
    const ref = refParts.join(" ");

    const ratio = computeContentOverlap(
      newContent.substring(0, 1500),  // tăng từ 1000 lên 1500 để bắt được nhiều hơn
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
// FIX CODE BLOCK INTEGRITY (MỚI)
// Nếu content có số lần ``` lẻ → code block chưa đóng → xóa block dở dạng cuối cùng
// ─────────────────────────────────────────────
const fixUnclosedCodeBlocks = (content) => {
  if (!content) return content;
  const fenceMatches = content.match(/^```/gm) || [];
  if (fenceMatches.length % 2 === 0) return content; // Đã chẵn, không cần sửa

  // Tìm vị trí ``` mở cuối cùng không có cặp đóng
  const lastOpenIdx = content.lastIndexOf("\n```");
  if (lastOpenIdx === -1) return content;

  // Cắt bỏ từ ``` mở dở dạng đó trở đi
  const fixed = content.substring(0, lastOpenIdx).trim();
  console.warn("[FenceGuard] Đã xóa code block không đóng, cắt tại:", lastOpenIdx);
  return fixed;
};

// ─────────────────────────────────────────────
// SECTION NUMBER HELPERS
// ─────────────────────────────────────────────
const getSectionNumFromLine = (line) => {
  const t = String(line || "").trim()
    .replace(/^\*+|\*+$/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^bổ\s*sung:\s*/i, "");
  const m = t.match(/(?:^|\s)(\d+(?:\.\d+)+)\s+/);
  return m ? m[1] : null;
};

const isSectionHeadingLine = (line) => {
  const t = String(line || "").trim();
  if (/^#{1,4}\s+\d+(?:\.\d+)+\s/.test(t)) return true;
  if (/^\*{1,2}\d+(?:\.\d+)+\s/.test(t)) return true;
  if (/^\d+(?:\.\d+)+\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) return true;
  const tNorm = t.normalize("NFC");
  if (/^#{1,4}\s+bổ\s*sung(\s*:|$)/i.test(tNorm)) return true;
  return false;
};

const getAllowedSectionNums = (coveredSections = []) =>
  new Set(
    coveredSections
      .map((s) => (String(s).match(/(\d+(?:\.\d+)+)/) || [])[1])
      .filter(Boolean)
  );

const getAllowedMajorChapters = (allowedNums) =>
  new Set([...allowedNums].map((n) => n.split(".")[0]).filter(Boolean));

const isSectionNumAllowed = (num, allowedNums) => {
  if (!num || !allowedNums?.size) return true;
  if (allowedNums.has(num)) return true;
  for (const a of allowedNums) {
    if (num.startsWith(`${a}.`)) return true;
  }
  const major = num.split(".")[0];
  const allowedMajors = getAllowedMajorChapters(allowedNums);
  return allowedMajors.has(major);
};

const filterChunksByCoveredSections = (chunks, coveredSections = []) => {
  if (!Array.isArray(chunks) || !coveredSections.length) return chunks;

  const allowedNums = getAllowedSectionNums(coveredSections);

  // Tài liệu có cấu trúc số mục X.Y
  if (allowedNums.size) {
    // FIX: xác định xem tất cả allowed nums có thuộc cùng 1 chapter không
    // Nếu có → cho phép toàn bộ chunk cùng chapter đó
    // Lý do: outline có thể bị gap (bold heading bị bỏ sót bởi docling/OCR)
    // → chunk nền tảng (1.1) bị drop oan dù ngày học chỉ có (1.2, 1.3)
    const allowedMajors = new Set([...allowedNums].map(n => n.split(".")[0]));
    const singleChapter = allowedMajors.size === 1 ? [...allowedMajors][0] : null;

    const filtered = chunks.filter((chunk) => {
      const sec = String(chunk.section || "");
      // FIX: strip bold/italic trong section name trước khi extract số mục
      const secClean = sec.replace(/[*_`]/g, "").trim();
      const secNum = (secClean.match(/(\d+(?:\.\d+)+)/) || [])[1]
        || (String(chunk.content || "").match(/^(\d+(?:\.\d+)+)\s/m) || [])[1];

      // Chunk không có số mục → bỏ qua (thường là noise)
      if (!secNum) return false;

      // FIX: nếu tất cả coveredSections thuộc cùng 1 chapter
      // → giữ lại mọi chunk cùng chapter, kể cả số mục không khớp chính xác
      // Tránh bỏ sót chunk nền tảng do gap trong outline
      if (singleChapter && secNum.startsWith(`${singleChapter}.`)) return true;

      return isSectionNumAllowed(secNum, allowedNums);
    });

    if (filtered.length > 0) return filtered;
    console.warn("[ScopeFilter] No chunks matched section nums", [...allowedNums], "— returning empty");
    return [];
  }

  // Tài liệu không đánh số: lọc theo cụm từ tiêu đề section
  const keys = coveredSections
    .map((s) => normalizeVN(String(s)).slice(0, 30))
    .filter((k) => k.length > 4);

  if (!keys.length) return chunks;

  const filtered = chunks.filter((chunk) => {
    const blob = normalizeVN(`${chunk.section || ""} ${String(chunk.content || "").slice(0, 400)}`);
    return keys.some((k) => blob.includes(k.slice(0, Math.min(20, k.length))));
  });

  if (filtered.length >= 1) return filtered;
  console.warn("[ScopeFilter] No keyword match for sections", keys.slice(0, 3), "— returning empty");
  return [];
};

// ─────────────────────────────────────────────
// POST-GENERATION SCOPE STRIPPER
// Loại bỏ nội dung AI viết thuộc section không nằm trong coveredSections
// Domain-agnostic: chỉ strip khi tài liệu có đánh số X.Y
// ─────────────────────────────────────────────

/**
 * Sự khác biệt với isSectionNumAllowed:
 * strict hơn — chỉ cho phép đúcng số mục trong coveredSections và con của chúng.
 * Không cho phép toàn bộ major chapter (ví dụ: 1.x không cho phép 1.4 nếu chỉ được phép 1.1, 1.2).
 */
// Cần thêm check: nếu số mục là sub-number của allowed → giữ lại
const isSectionNumAllowedStrict = (num, allowedNums) => {
  if (!num || !allowedNums?.size) return true;
  if (allowedNums.has(num)) return true;
  // Cho phép con trực tiếp: 1.7 → 1.7.1, 1.7.2
  for (const a of allowedNums) {
    if (num.startsWith(`${a}.`)) return true;
  }
  // FIX MỚI: nếu num là phần cuối của một allowed num
  // VD: "7.1" xuất hiện trong context của "1.7" → không phải heading thật
  // → chỉ strip nếu num xuất hiện ở đầu dòng heading thực sự
  return false;
};
/**
 * Strip nội dung AI sinh ra thuộc section ngoài phạm vi của ngày học.
 *
 * Hoạt động:
 *  - Phát hiện tiêu đề có số mục trong output AI ("### 2.3 Giao dịch", "2.3 Title")
 *  - Nếu số mục đó không nằm trong coveredSections → xóa tiêu đề + nội dung
 *  - Chỉ strip khi coveredSections có số mục (X.Y) — không ảnh hưởng tài liệu phi số
 */
const stripOutOfScopeHeadings = (content, coveredSections = []) => {
  if (!content || !coveredSections.length) return content;

  const allowedNums = getAllowedSectionNums(coveredSections);
  if (!allowedNums.size) return content;

  // FIX: nếu tất cả allowed nums thuộc cùng 1 chapter → không strip heading cùng chapter
  // Nhất quán với filterChunksByCoveredSections: tránh xóa oan heading nền tảng
  const allowedMajors = new Set([...allowedNums].map(n => n.split(".")[0]));
  const singleChapter = allowedMajors.size === 1 ? [...allowedMajors][0] : null;

  const lines = content.split("\n");
  const result = [];
  let inBadSection = false;

  for (const line of lines) {
    const t = line.trim();

    const mdHeadingMatch = t.match(/^(#{1,4})\s+(\d+(?:\.\d+)+)\b/);
    const plainNumMatch = !mdHeadingMatch && t.match(/^(\d+(?:\.\d+)+)\s+[A-Z\u00C0-\u1EF9a-z\u00E0-\u1EF9]/);

    const secNum = mdHeadingMatch ? mdHeadingMatch[2]
      : plainNumMatch ? plainNumMatch[1]
        : null;

    if (secNum) {
      const isSubSection = (secNum.match(/\./g) || []).length >= 2;

      let isAllowed;
      if (isSubSection) {
        const parentNum = secNum.split(".").slice(0, 2).join(".");
        isAllowed = allowedNums.has(parentNum) || isSectionNumAllowedStrict(secNum, allowedNums);
      } else {
        isAllowed = isSectionNumAllowedStrict(secNum, allowedNums);
      }

      // FIX: cùng chapter với coveredSections → không bao giờ strip
      // Lý do: AI viết "### 1.1 ..." khi context có chunk 1.1 (do singleChapter logic)
      // Nếu strip thì bài bị mất nội dung nền tảng dù context đúng
      if (!isAllowed && singleChapter && secNum.startsWith(`${singleChapter}.`)) {
        isAllowed = true;
      }

      if (!isAllowed) {
        inBadSection = true;
        console.warn(`[ScopeStrip] Removed out-of-scope section ${secNum} (allowed: ${[...allowedNums].join(",")})`);
        continue;
      } else {
        inBadSection = false;
      }
    } else if (inBadSection) {
      if (/^#{1,4}\s+[A-Z\u00C0-\u1EF9a-z\u00E0-\u1EF9]/.test(t) && !t.match(/^#{1,4}\s+\d/)) {
        inBadSection = false;
      } else {
        continue;
      }
    }

    result.push(line);
  }

  const stripped = result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const removedLines = lines.length - result.length;
  if (removedLines > 0) {
    console.log(`[ScopeStrip] Removed ${removedLines} out-of-scope lines from lesson`);
  }
  return stripped;
};

const stripSupplementSections = (content) => {
  if (!content) return content;
  const lines = content.split("\n");
  const output = [];
  let skip = false;

  for (const line of lines) {
    const t = line.trim();
    // FIX: normalize trước khi test để tránh fixOcrGluedWords làm hỏng dấu
    const tNorm = t.normalize("NFC");
    if (/^#{1,4}\s+bổ\s*sung(\s*:|$)/i.test(tNorm) || /^#{1,4}\s+supplement/i.test(tNorm)) {
      skip = true;
      continue;
    }
    if (skip && isSectionHeadingLine(line) && !/^#{1,4}\s+bổ\s*sung(\s*:|$)/i.test(tNorm)) {
      skip = false;
    }
    if (!skip) output.push(line);
  }

  return output.join("\n");
};

const stripLessonMetadata = (content) => {
  if (!content) return content;

  const META_RE = /^\*{0,2}(Ngày|Bloom|Chủ đề|Mục\s*[Tt]iêu|Nội\s*[Dd]ung|Bài\s*giảng)\s*:\*{0,2}\s*.+$/i;

  // FIX: bắt thêm heading "### Mục tiêu", "## Objective", "## Overview"
  // và toàn bộ bullet/text ngay bên dưới (cho đến khi gặp heading khác hoặc dòng trống kép)
  const META_HEADING_RE = /^#{1,4}\s*(Mục\s*tiêu|Objective|Overview)\s*$/i;

  const lines = content.split("\n");
  const output = [];
  let skipMetaBlock = false;

  for (const line of lines) {
    const t = line.trim();

    // Phát hiện heading meta → bắt đầu skip block
    if (META_HEADING_RE.test(t)) {
      skipMetaBlock = true;
      continue;
    }

    // Kết thúc skip block khi gặp:
    // - Heading thật (## / ###) không phải meta
    // - Hoặc dòng trống sau ít nhất 1 dòng content bị skip
    if (skipMetaBlock) {
      const isNewHeading = /^#{1,4}\s+\S/.test(t);
      if (isNewHeading) {
        skipMetaBlock = false;
        // Không continue — heading mới này được giữ lại
      } else {
        continue; // bỏ bullet/text thuộc block meta
      }
    }

    // Lọc dòng meta dạng "Mục tiêu: ..." inline (regex cũ)
    if (META_RE.test(t)) continue;

    output.push(line);
  }

  return output.join("\n");
};
const stripOutOfScopeSections = (content, coveredSections = []) => {
  if (!content || !coveredSections.length) return content;

  const allowedNums = getAllowedSectionNums(coveredSections);
  // Không có số mục X.Y → chỉ dựa prompt + lọc chunk, không cắt heading theo keyword
  if (!allowedNums.size) return content;

  const lines = content.split("\n");
  const output = [];
  let skip = false;
  let removed = 0;

  for (const line of lines) {
    const t = line.trim();           // ← PHẢI có dòng này
    const tNorm = t.normalize("NFC"); // ← t được dùng ở đây

    if (/^#{1,4}\s+bổ\s*sung(\s*:|$)/i.test(tNorm)) {
      skip = true;
      removed++;
      continue;
    }

    const sectionNum = getSectionNumFromLine(line);

    if (sectionNum && (isSectionHeadingLine(line) || /^#{1,4}\s+/.test(t))) {
      if (!isSectionNumAllowed(sectionNum, allowedNums)) {
        skip = true;
        removed++;
        console.log(`[ScopeStrip] Loại mục ngoài phạm vi: ${sectionNum}`);
        continue;
      }
      skip = false;
    }

    if (!skip) output.push(line);
  }

  if (removed > 0) {
    console.log(`[ScopeStrip] Đã loại ${removed} section ngoài phạm vi`);
  }

  return output.join("\n").trim();
};

// ─────────────────────────────────────────────
// DEDUP SECTIONS — xóa heading/mục X.Y lặp trong cùng 1 bài
// ─────────────────────────────────────────────
const GENERIC_HEADINGS_NO_DEDUP = new Set([
  "ví dụ", "vi du", "example", "examples",
  "tóm tắt", "tom tat", "tóm tắt ghi nhớ", "summary",
  "ghi nhớ", "ghi nho", "note", "notes",
  "bài tập", "bai tap", "exercise", "exercises",
  "mở đầu", "mo dau", "introduction",
  "kết luận", "ket luan", "conclusion",
  "nhận xét", "nhan xet", "remark",
  "thực hành", "thuc hanh", "practice",
]);

const isGenericHeading = (headingText) => {
  const norm = String(headingText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
  return GENERIC_HEADINGS_NO_DEDUP.has(norm) || norm.length <= 10;
};

const removeDuplicateSections = (content) => {
  if (!content || typeof content !== "string") return content;

  const lines = content.split("\n");
  const seenHeadings = new Set();
  const seenSectionNums = new Set();
  const outputLines = [];
  let skipUntilNextHeading = false;
  let removedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const sectionNum = getSectionNumFromLine(line);
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/)
      || trimmed.match(/^\*{1,2}(\d+(?:\.\d+)+)\s+(.+)/);

    if (headingMatch || sectionNum) {
      const headingText = headingMatch
        ? (headingMatch[2] || headingMatch[3] || "").trim().toLowerCase()
        : "";

      // ✅ FIX 3: KHÔNG dedup heading generic ngắn
      if (isGenericHeading(headingText)) {
        // Reset skip — generic heading luôn được giữ
        skipUntilNextHeading = false;
        outputLines.push(line);
        continue;
      }

      const headingKey = headingMatch
        ? `${headingMatch[1] || "**"}|${headingText}`
        : `num|${sectionNum}`;

      const isDupHeading = seenHeadings.has(headingKey);
      const isDupSectionNum = sectionNum && seenSectionNums.has(sectionNum);

      if (isDupHeading || isDupSectionNum) {
        skipUntilNextHeading = true;
        removedCount++;
        console.log(`[DedupSection] Xóa section trùng có số mục: "${headingText || sectionNum}"`);
        continue;
      }

      seenHeadings.add(headingKey);
      if (sectionNum) seenSectionNums.add(sectionNum);
      skipUntilNextHeading = false;
    } else if (skipUntilNextHeading) {
      // Nếu gặp heading mới không có số → kết thúc skip
      if (/^#{1,4}\s+[A-Z\u00C0-\u1EF9a-z\u00E0-\u1EF9]/.test(trimmed) && !trimmed.match(/^#{1,4}\s+\d/)) {
        skipUntilNextHeading = false;
        // Không continue — line này sẽ được xử lý ở vòng lặp tiếp theo
      } else {
        continue;
      }
    }

    outputLines.push(line);
  }

  if (removedCount > 0) {
    console.log(`[DedupSection] Đã xóa ${removedCount} section có số mục trùng lặp`);
  }

  return outputLines.join("\n");
};


// ─────────────────────────────────────────────
// POLISH DETERMINISTIC — thay thế bước AI selfCheck (nhanh hơn, ổn định hơn)
// ─────────────────────────────────────────────
const polishLessonContent = (content, coveredSections = []) => {
  if (!content) return content;

  let polished = fixOcrGluedWords(content);

  // FIX: stripLessonMetadata trước — bắt cả heading "### Mục tiêu" + block bên dưới
  // Gọi 1 lần duy nhất, bỏ lần gọi thứ 2 ở cuối (trùng lặp)
  polished = stripLessonMetadata(polished);

  polished = stripSupplementSections(polished);
  polished = stripOutOfScopeSections(polished, coveredSections);
  polished = removeDuplicateSections(polished);
  polished = fixUnclosedCodeBlocks(polished);
  polished = polished.replace(/\n{3,}/g, "\n\n").trim();

  return polished;
};

// ─────────────────────────────────────────────
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


// ─────────────────────────────────────────────
// FALLBACK QUIZ BUILDER — domain-agnostic
// Tạo quiz cơ bản từ context text khi AI quiz fail.
// KHÔNG hardcode theo SQL hay bất kỳ domain nào.
// ─────────────────────────────────────────────
const buildFallbackQuiz = (topic, contextText, importantNotes = [], minCount = 3, practiceBias = false) => {
  // Fallback đơn giản: tạo câu hỏi skeleton từ importantNotes hoặc context
  // Quiz này sẽ được lọc qua normalizeQuizItem nên cần đủ cấu trúc
  const quizItems = [];
  const src = String(contextText || "").slice(0, 3000);

  // Trích các câu có dấu hiệu định nghĩa/phân loại
  const candidates = [
    ...importantNotes.slice(0, 6).map(n => String(n)),
    ...(src.match(/^.{20,120}(?:là|is|được gọi là|defined as).{10,80}$/gm) || []).slice(0, 4),
    ...(src.match(/^\s*\d+[.)].{15,100}$/gm) || []).slice(0, 4),
  ].filter(s => s && s.length >= 20);

  // Không đủ nguyên liệu → trả rỗng để pipeline xử lý tiếp
  if (candidates.length < 2) return [];

  for (let i = 0; i < Math.min(candidates.length, minCount); i++) {
    const stem = candidates[i].replace(/^[\d.)\-•◦\s]+/, '').trim().slice(0, 120);
    if (!stem || stem.length < 15) continue;

    // Tạo câu hỏi yêu cầu chọn phát biểu đúng
    const question = practiceBias
      ? `Trong ngữ cảnh "${topic}", phát biểu nào sau đây mô tả đúng?`
      : `Phát biểu nào sau đây đúng về "${topic}"?`;

    // Đáp án A là stem thật, B-D là nhiễu generic
    quizItems.push({
      question,
      options: [
        stem.slice(0, 100),
        `Đây là mô tả về một khái niệm khác, không liên quan đến ${topic}.`,
        `Điều này hoàn toàn trái ngược với nội dung đã học.`,
        `Đây là ví dụ minh họa, không phải định nghĩa.`,
      ],
      correctAnswer: 0,
      explanation: `Theo tài liệu, ${stem.slice(0, 80)}.`,
    });
  }

  return quizItems;
};

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
    const s = normalizeSpace(fixOcrGluedWords(String(x || "")));
    if (!s) return null;

    // ── MỚI: Chặn prompt leakage ─────────────────────────────────────────
    if (/QUY TẮC BẮT BUỘC|YÊU CẦU OUTPUT|THÔNG TIN BÀI|CHẾ ĐỘ:/i.test(s)) return null;
    if (/^(BẮT BUỘC|NGHIÊM CẤM|FORBIDDEN|CẤM TUYỆT ĐỐI|KHÔNG ĐƯỢC)/i.test(s)) return null;
    if (/^(⚠️|❗|🎯|⛔|✅|🚫)/.test(s)) return null;
    if (/(CHỈ DÙNG|KHÔNG BỊA|KHÔNG SỬ DỤNG|TỰ KIỂM TRA)/i.test(s)) return null;

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

    return fixOcrGluedWords(s);
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



const extractNotesFromMarkdown = (content = "") => {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const results = [];
  let insideCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code block
    if (/^```/.test(line)) { insideCodeBlock = !insideCodeBlock; continue; }
    if (insideCodeBlock) continue;

    // Bỏ qua tiêu đề, phân cách, prompt leakage
    if (/^#{1,4}\s/.test(line)) continue;
    if (/^[-=─]{2,}$/.test(line)) continue;
    if (/QUY TẮC|BẮT BUỘC|KHÔNG ĐƯỢC|YÊU CẦU|CHỈ DÙNG/i.test(line)) continue;
    if (/^(⚠️|❗|🎯|⛔|✅|🚫)/.test(line)) continue;
    if (line.length < 15 || line.length > 250) continue;
    const letters = (line.match(/[a-zA-ZÀ-ỹ]/g) || []).length;
    if (letters < 8) continue;

    // ── Detect các dạng có giá trị ──────────────────────────────────────
    const isDef = /(là |được định nghĩa|khái niệm|định nghĩa:|có nghĩa là)/i.test(line);
    const isRule = /^(\*\*Lưu ý|\*\*Chú ý|\*\*Quan trọng|Lưu ý:|Chú ý:|Quan trọng:)/i.test(line)
      || /(khi .{5,} thì |nếu .{5,} thì |không được|phải |cần phải)/i.test(line);
    const isEnum = /(có \d+ |gồm \d+ |phân thành|bao gồm:|\d+ loại|\d+ bước)/i.test(line);
    const isBullet = /^[-*•]\s+.{30,}/.test(line)
      && (isDef || isRule || isEnum
        || /(ví dụ|ứng dụng|mục đích|đặc điểm|ưu điểm|nhược điểm)/i.test(line));

    // ── Cú pháp / công thức: label + dòng kế tiếp ───────────────────────
    const isFormulaLabel = /(cú pháp|syntax|công thức|formula|cấu trúc)[^a-zA-ZÀ-ỹ]*$/i.test(line);

    if (isFormulaLabel) {
      // Lấy tối đa 2 dòng tiếp theo làm nội dung
      const nextLines = [];
      for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || /^#{1,4}\s/.test(next)) break;
        nextLines.push(next.replace(/\*\*/g, ""));
      }

      if (nextLines.length > 0) {
        const combined = line.replace(/\*\*/g, "").replace(/:\s*$/, "")
          + ": "
          + nextLines.join(" | ").slice(0, 180);
        results.push(combined);
        i += nextLines.length; // skip dòng đã dùng
        continue;
      }
      // Nếu không có dòng tiếp theo thì bỏ qua label rỗng
      continue;
    }

    // ── Công thức inline (có ký tự toán + chữ) ───────────────────────────
    const isFormulaInline = /[=+\-*/^]/.test(line) && /[a-zA-ZÀ-ỹ]{4,}/.test(line)
      && !/:\s*$/.test(line); // không phải label rỗng

    if (isDef || isRule || isEnum || isBullet || isFormulaInline) {
      const clean = line.replace(/\*\*/g, "").replace(/^[-*•]\s+/, "").trim();
      if (clean.length >= 20) results.push(clean);
    }
  }

  return [...new Set(results)].slice(0, 7);
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
    const prefix = sig.substring(0, 180);  // ✅ FIX: Tăng từ 80 → 180 để dedup chính xác, không loại oan chunk chỉ trùng heading

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

const isTocLikeChunk = (chunk) => {
  const content = String(chunk?.content || "").trim();
  if (!content) return true;

  const section = String(chunk?.section || "").trim();
  const firstLine = content.split(/\r?\n/)[0].trim();
  const lowerFirst = firstLine.toLowerCase();

  if (/^(mục lục|table of contents|nội dung|contents|index)\b/.test(lowerFirst)) return true;
  if (/^(mục lục|table of contents|nội dung|contents|index)\b/i.test(section.toLowerCase())) return true;

  const headingLines = content.split(/\r?\n/).slice(0, 5);
  const numericLineCount = headingLines.filter((line) =>
    /^\s*\d+(?:\.\d+)*\s*(?:\S.*)?$/.test(line.trim())
  ).length;

  if (numericLineCount >= 3 && !/[.!?]/.test(content.slice(0, 200))) return true;

  if (content.length < 140 && /^[\d\s\.\-–—:;,]+$/.test(content)) return true;

  return false;
};

const filterOutTocChunks = (chunks) =>
  Array.isArray(chunks)
    ? chunks.filter((chunk) => !isTocLikeChunk(chunk))
    : [];

// ─────────────────────────────────────────────
// HyDE (Hypothetical Document Embedding)
// ─────────────────────────────────────────────

const generateHyDE = async (topic, objective) => {
  try {
    const response = await makeGroqPlainRequest({
      messages: [
        {
          role: "user",
          content: `Viết một đoạn mô tả kiến thức chi tiết (3-4 câu) cho chủ đề: "${topic}".
Mục tiêu học: ${objective || topic}.
Chỉ trả về đoạn văn, không giải thích thêm.`,
        },
      ],
      model: MODEL_FAST,
      temperature: 0.3,
      maxTokens: 180,
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
  keyFacts = [],           // ← THÊM
  codeIdentifiers = [],    // ← THÊM
}) => {
  const avoidBlock = (avoidQuestions || [])
    .slice(0, 8)
    .map((q, i) => `${i + 1}. ${String(q).slice(0, 100)}`)
    .join("\n");

  const formulaHint = Array.isArray(formulaNotes) && formulaNotes.length > 0
    ? `\nCONG THUC: ${formulaNotes.slice(0, 4).join("; ")}`
    : "";

  // ✅ FIX: inject keyFacts để AI không bỏ sót khái niệm quan trọng
  const keyFactsHint = Array.isArray(keyFacts) && keyFacts.length > 0
    ? `\nCAC KHAI NIEM QUAN TRONG PHAI CO TRONG QUIZ:\n${keyFacts.slice(0, 6).map((f, i) => `${i + 1}. ${f}`).join("\n")}`
    : "";

  // ✅ FIX: inject identifiers giúp quiz dùng đúng tên thuật ngữ từ tài liệu
  const identifierHint = Array.isArray(codeIdentifiers) && codeIdentifiers.length > 0
    ? `\nTHUAT NGU CHINH XAC: ${codeIdentifiers.slice(0, 8).join(", ")}`
    : "";

  return `Tao dung ${count} cau trac nghiem 4 phuong an de cung co kien thuc tu CONTEXT.

TOPIC: ${searchTopic}
MUC TIEU: ${objective || searchTopic}${formulaHint}${keyFactsHint}${identifierHint}

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
            keyFacts,          // ← THÊM
            codeIdentifiers,   // ← THÊM
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


/**
 * 🔍 HÀM KIỂM DUYỆT CHỐNG SUY DIỄN (Fact Verification Pass)
 * Đối chiếu Draft bài giảng với Context gốc. Loại bỏ bất kỳ thông tin tự ý bịa đặt hoặc suy diễn nào.
 */
const verifyLessonContent = async (draftContent, context, model = MODEL_FAST, coveredSections = []) => {
  if (!draftContent || draftContent.length < 100) {
    return { hasHallucinations: false, correctedContent: draftContent, hallucinations: [] };
  }

  const sectionsListBlock = Array.isArray(coveredSections) && coveredSections.length > 0
    ? `\nDANH SÁCH TIÊU ĐỀ/CHỦ ĐỀ BẮT BUỘC PHẢI DẠY TRONG BÀI NÀY:\n${coveredSections.map((s, i) => `- [Mục ${i + 1}]: ${s}`).join("\n")}\n`
    : "";

  const prompt = `Bạn là một Verifier chuyên kiểm duyệt tài liệu giáo dục và đảm bảo độ bao phủ kiến thức (Knowledge Coverage Check) cho đa dạng lĩnh vực học thuật (như Khoa học, Công nghệ, Y học, Luật pháp, Kinh tế, Lập trình...).
Nhiệm vụ: Đối chiếu bản nháp bài giảng (Draft) với tài liệu gốc (Context) để phát hiện lỗi sai lệch thông tin hoặc tự suy diễn (Hallucination) VÀ phát hiện xem bài giảng có bỏ sót kiến thức cốt lõi nào từ tài liệu gốc không (Coverage Check).
${sectionsListBlock}
⚠️ QUY TẮC PHÁT HIỆN & SỬA LỖI (BẮT BUỘC):
1. KIỂM TRA ĐỘ BAO PHỦ BẮT BUỘC (KNOWLEDGE COVERAGE CHECK):
   - Đọc kỹ danh sách "DANH SÁCH TIÊU ĐỀ/CHỦ ĐỀ BẮT BUỘC PHẢI DẠY" ở trên.
   - Đối chiếu với bản nháp bài giảng (Draft). Nếu phát hiện bản nháp bỏ sót hoặc giải thích quá sơ sài bất kỳ tiêu đề/chủ đề nào trong danh sách trên, bạn bắt buộc phải trích xuất thông tin tương ứng từ CONTEXT gốc để bổ sung chi tiết vào "correctedContent".
   - Đối với từng mục, phải viết rõ tiêu đề tương ứng và giải thích mạch lạc.

2. CHỐNG HALLUCINATION (TRÁNH BỊA ĐẶT & SUY DIỄN):
   - Đối chiếu từng định nghĩa, công thức, ví dụ minh họa, tên thực thể xuất hiện trong DRAFT với CONTEXT.
   - Nếu DRAFT giải thích, định nghĩa hoặc bổ sung thêm các ví dụ, phương pháp thực hành, thông tin chi tiết mà CONTEXT hoàn toàn không nhắc đến -> Đó là HALLUCINATION.
   - Hành động sửa lỗi: Cắt bỏ hoàn toàn phần thông tin tự ý suy diễn đó, hoặc thay thế bằng ghi chú trung thực: "Tài liệu gốc không đề cập nội dung này".
   - Tuyệt đối chỉ sử dụng các ví dụ thực tế có sẵn trong CONTEXT. Nếu CONTEXT không có ví dụ cụ thể, hãy đổi thành giải thích lý thuyết thuần túy trích từ CONTEXT và ghi rõ: "Tài liệu không cung cấp ví dụ cụ thể cho trường hợp này."
   - Nếu CONTEXT chứa "<!-- image -->" hoặc "[Hình]" → ghi rõ "*(Tài liệu gốc có hình minh họa tại đây)*" — KHÔNG tự bịa số liệu thay thế.
3. TRẢ VỀ KẾT QUẢ:
   - Trả về bài giảng hoàn chỉnh sau khi đã được bổ sung phần thiếu và loại bỏ phần bịa đặt. Định dạng Markdown gốc.

CONTEXT GỐC:
${context}

DRAFT BÀI GIẢNG CẦN KIỂM DUYỆT:
${draftContent}

TRẢ VỀ ĐÚNG ĐỊNH DẠNG JSON SAU:
{
  "hasHallucinations": true/false,
  "hallucinations": ["mô tả chi tiết lỗi sai lệch hoặc lỗi thiếu kiến thức quan trọng"],
  "correctedContent": "Nội dung bài giảng hoàn chỉnh đã sạch lỗi hallucination, đã bổ sung đầy đủ kiến thức bị thiếu và đúng định dạng Markdown"
}
`;

  try {
    const resText = await makeGroqRequest({
      messages: [
        { role: "system", content: "Chỉ trả về JSON hợp lệ chứa correctedContent." },
        { role: "user", content: prompt }
      ],
      model: model,
      temperature: 0.0, // Đảm bảo tính nhất quán tuyệt đối
      enforceJSON: true
    });

    const parsed = safeJSONParse(resText);
    if (parsed && typeof parsed.correctedContent === "string" && parsed.correctedContent.length > 50) {
      // ✅ FIX: Guard - reject nếu verifier cắt quá tay (correctedContent < 40% gốc)
      const minAcceptableLength = Math.max(100, Math.floor(draftContent.length * 0.4));
      if (parsed.correctedContent.length < minAcceptableLength) {
        console.warn(
          `[VerifyGuard] Rejected verifier output - too much cut ` +
          `(${parsed.correctedContent.length} < ${minAcceptableLength} chars). Using draft.`
        );
        return { hasHallucinations: false, correctedContent: draftContent, hallucinations: [] };
      }
      return parsed;
    }
    return { hasHallucinations: false, correctedContent: draftContent, hallucinations: [] };
  } catch (error) {
    console.error("❌ [Verifier] Error during verification:", error.message);
    return { hasHallucinations: false, correctedContent: draftContent, hallucinations: [] };
  }
};

/**
 * 🔍 KIỂM TRA CHẤT LƯỢNG TEXT CÓ CẦN LLM LÀM SẠCH KHÔNG (Heuristics)
 * Giúp tránh lãng phí token & tránh dính lỗi rate limit 429 TPD từ Groq.
 */
const checkTextQualityNeedsLLM = (text) => {
  const t = String(text || "").trim();
  if (t.length < 50) return false;

  // 1. Chứa bảng biểu -> luôn cần LLM xử lý định dạng
  if (t.includes("|")) return true;

  // 2. Tách từ thành danh sách các từ
  // Xóa các dấu câu ở đầu và cuối từ để tính độ dài chính xác
  const words = t.split(/[\s,.\/#!$%\^&\*;:{}=\-_`~()?"']+/).filter(Boolean);

  const viVowelsWithTone = /[áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/i;

  for (const w of words) {
    // A. Kiểm tra từ tiếng Anh CamelCase (như dnaPolymerase, StoredProcedure)
    if (/[a-z]+[A-Z][a-z]+/.test(w)) return true;

    // B. Nếu từ dài hơn 8 ký tự và có chứa chữ tiếng Việt có dấu -> khả năng rất cao bị dính chữ (ví dụ: "trongquatrinh")
    if (w.length > 8 && viVowelsWithTone.test(w)) {
      return true;
    }

    // C. Đếm số ký tự có dấu cách nhau bởi phụ âm trong cùng 1 từ (ví dụ: "nhânđôi" -> 'â' và 'ô' cách nhau bởi 'nđ')
    const matches = w.match(/[áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/gi) || [];
    if (matches.length >= 2) {
      let toneIndices = [];
      for (let idx = 0; idx < w.length; idx++) {
        if (viVowelsWithTone.test(w[idx])) {
          toneIndices.push(idx);
        }
      }
      for (let k = 0; k < toneIndices.length - 1; k++) {
        if (toneIndices[k + 1] - toneIndices[k] > 2) {
          return true; // cách nhau bởi phụ âm -> dính chữ
        }
      }
    }
  }

  // 3. Kiểm tra độ dài từ trung bình quá lớn
  if (words.length > 0) {
    const avgLength = words.reduce((acc, w) => acc + w.length, 0) / words.length;
    if (avgLength > 10) return true;
  }

  return false;
};

/**
 * 🧹 LLM POST-PROCESSING CHUNK (Đa lĩnh vực)
 * Sửa lỗi chính tả, dính chữ (glued words), lỗi font OCR, chuẩn hóa thuật ngữ chuyên môn.
 * Hoạt động domain-agnostic (Luật, Y tế, Kinh tế, Lập trình...).
 */
const postProcessChunkWithLLM = async (rawChunkText) => {
  if (!rawChunkText || rawChunkText.trim().length < 50) {
    return rawChunkText;
  }

  // 🔥 CHỈ GỌI LLM KHI CẦN THIẾT (Selective processing)
  // Tiết kiệm hơn 80% token và lượt gọi API, chống tuyệt đối rate limit 429
  if (!checkTextQualityNeedsLLM(rawChunkText)) {
    return rawChunkText;
  }

  const prompt = `Bạn là một chuyên gia hiệu đính tài liệu học thuật đa lĩnh vực đẳng cấp quốc tế.
Nhiệm vụ: Sửa lỗi chính tả, tách các từ bị dính chữ (glued words), sửa lỗi font OCR và chuẩn hóa từ ngữ chuyên môn của đoạn văn bản dưới đây.

⚠️ CÁC QUY TẮC BẮT BUỘC (BẢO VỆ THUẬT NGỮ CHUYÊN NGÀNH):
1. KHÔNG DỊCH THUẬT NGỮ TIẾNG ANH:
   - Các thuật ngữ chuyên ngành tiếng Anh (ví dụ: "dna", "dnaPolymerase", "nucleotide", "SQL", "StoredProcedure") phải được chuẩn hóa đúng dạng viết hoa/thường chuyên môn của chúng (ví dụ: "DNA", "DNA Polymerase", "nucleotide", "SQL", "Stored Procedure"). Tuyệt đối KHÔNG dịch nghĩa các thuật ngữ này sang tiếng Việt (ví dụ: KHÔNG dịch "dna" thành "và", "polymerase" thành "kích thích").
2. SỬA LỖI FONT TIẾNG VIỆT & TÁCH DÍNH CHỮ:
   - Các từ tiếng Việt bị dính liền do lỗi OCR (ví dụ: "trongquatrinh" -> "trong quá trình", "tìnhbáocáo" -> "tình báo cáo" hoặc "trình báo cáo" tùy ngữ cảnh chuyên môn) phải được tách ra chính xác.
   - Sửa các từ bị lỗi dấu font chữ tiếng Việt (ví dụ: "Điềunày" -> "Điều này", "ditruyền" -> "di truyền") dựa vào ngữ cảnh học thuật của câu.
3. BẢO TOÀN NỘI DUNG 100%:
   - Giữ nguyên toàn bộ cấu trúc câu, các số liệu, ví dụ thực tế và thông tin học thuật. Không thêm bớt bất kỳ kiến thức ngoài tài liệu nào. KHÔNG viết thêm nhận xét hay tóm tắt.

VĂN BẢN GỐC CẦN HIỆU ĐÍNH:
${rawChunkText}

Trả về văn bản đã làm sạch hoàn chỉnh (Chỉ trả về văn bản sau hiệu đính, không thêm bất kỳ văn bản dẫn giải nào khác):`;

  try {
    const cleanedText = await makeGroqPlainRequest({
      messages: [{ role: "user", content: prompt }],
      model: MODEL_FAST,
      temperature: 0.0,
      maxTokens: 2500
    });
    return cleanedText && cleanedText.trim().length > 20 ? cleanedText.trim() : rawChunkText;
  } catch (err) {
    console.warn("⚠️ [LLM Post-processing] Lỗi hoặc rate limit, giữ nguyên chunk gốc:", err.message);
    return rawChunkText;
  }
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
}) => {
  let budget = getDynamicLessonBudget(totalDays || 7);
  const useSmarter = budget.useSmarter && profile.depth !== "basic";
  const contentModel = useSmarter ? MODEL_SMART : MODEL_FAST;
  // =========================
  // CONTEXT GUARD
  // =========================
  const safeContext = fixOcrGluedWords(
    smartTruncateContext(
      String(context || "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n"),
      6500,
      600   // luôn giữ 600 ký tự cuối (thường chứa ví dụ hoặc định nghĩa quan trọng)
    )
  );

  // =========================
  // TOKEN CAP KHI CONTEXT MỎNG
  // =========================
  const contextCharCount = safeContext.replace(/\s/g, "").length;
  if (contextCharCount < 800) {
    budget = { ...budget, contentTokens: Math.min(budget.contentTokens, 1200) };
    console.warn(`[TokenCap] Context mỏng (${contextCharCount} chars) → cap ${budget.contentTokens}`);
  } else if (contextCharCount < 2000) {
    budget = { ...budget, contentTokens: Math.min(budget.contentTokens, 1800) };
    console.warn(`[TokenCap] Context trung bình (${contextCharCount} chars) → cap ${budget.contentTokens}`);
  }

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

  const allowedNumsList = [...getAllowedSectionNums(coveredSections)];

  const scopeBlock = coveredSections.length > 0
    ? `━━━━━━━━━━ PHẠM VI BẮT BUỘC ━━━━━━━━━━
NHIỆM VỤ HÔM NAY (Ngày ${dayNumber}/${totalDays}):
Viết bài giảng về "${searchTopic}" tập trung vào:
${coveredSections.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

CHỈ ĐƯỢC DẠY các mục: ${allowedNumsList.join(", ") || "(theo danh sách trên)"}
CẤM TUYỆT ĐỐI:
- Viết bất kỳ mục X.Y nào KHÔNG nằm trong danh sách trên (ví dụ: nếu chỉ có 1.2, 1.3 thì CẤM viết 2.1, 2.4...)
- Lặp lại cùng một mục X.Y nhiều lần trong bài
- Nhắc lại hoặc dạy lại: ${forbiddenTopics || "(chưa có)"}
- Tự suy diễn/bịa ví dụ ngoài CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    : `━━━━━━━━━━ PHẠM VI ━━━━━━━━━━
NHIỆM VỤ HÔM NAY (Ngày ${dayNumber}/${totalDays}):
Viết bài giảng về "${searchTopic}"
MỤC TIÊU: ${objective || "Bám sát nội dung cốt lõi"}
CẤM dạy lại: ${forbiddenTopics || "(chưa có)"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;


  // =========================
  // EXAMPLE & IDENTIFIER HINT — domain-agnostic
  // =========================
  const identifiersList = Array.isArray(codeIdentifiers) && codeIdentifiers.length > 0
    ? codeIdentifiers : [];

  const exampleHint = identifiersList.length > 0
    ? `
⚠️ THUẬT NGỮ / TÊN RIÊNG / KÝ HIỆU TRONG CONTEXT (ưu tiên dùng đúng các tên sau khi minh họa):
${identifiersList.join(", ")}

QUY TẮC MINH HỌA:
- NẾU CONTEXT CÓ SẴN ví dụ (công thức, đoạn văn, bảng biểu, mã, sơ đồ) → TRÍCH NGUYÊN vào bài, giữ đúng tên/ký hiệu/số liệu.
- KHÔNG đổi tên biến, ký hiệu, đại lượng sang tên khác.
- KHÔNG tự bịa tên mới, số liệu mới, hay ví dụ giả lập không có trong tài liệu.
- KHÔNG dùng placeholder mơ hồ (example, param1, tên_của_bạn, value_here, ...).
`
    : `
📄 CONTEXT KHÔNG CÓ VÍ DỤ CỤ THỂ:
- Trình bày bằng văn xuôi và bullet points; không tự ý thêm ví dụ, số liệu hay trích dẫn ngoài tài liệu.
`;

  // =========================
  // REQUIRED FACTS
  // =========================
  const factsList = Array.isArray(keyFacts) && keyFacts.length > 0 ? keyFacts : [];
  // THAY THẾ requiredFactsBlock cũ
  const requiredFactsBlock = factsList.length > 0
    ? `
❗ NỘI DUNG BẮT BUỘC ĐỀ CẬP (chỉ dùng nếu có trong CONTEXT):
${factsList.map((f, i) => `  [${i + 1}] ${f}`).join("\n")}

QUY TẮC CITE: Khi đề cập bất kỳ điểm nào trong danh sách trên, bạn PHẢI trích dẫn
nguyên văn tối thiểu 1 cụm từ từ CONTEXT để chứng minh thông tin có trong tài liệu.
Nếu không tìm thấy trong CONTEXT → KHÔNG đề cập, thay bằng: "Tài liệu không đề cập [điểm này]."
`
    : "";

  // =========================
  // CONCEPT MEMORY BLOCK — domain-agnostic
  // =========================
  const conceptMemoryBlock = (() => {
    const concepts = Array.isArray(usedConcepts) && usedConcepts.length > 0
      ? usedConcepts : [];
    if (!concepts.length) return "";

    // ✅ FIX: Cap output của buildUsedConceptsBlock để không chiếm quá nhiều token
    // Mục tiêu: conceptMemoryBlock tối đa ~600 chars (~150 tokens)
    const MAX_CONCEPT_BLOCK_CHARS = 600;
    let conceptList = buildUsedConceptsBlock(concepts);

    if (conceptList.length > MAX_CONCEPT_BLOCK_CHARS) {
      const truncated = conceptList.slice(0, MAX_CONCEPT_BLOCK_CHARS);
      const lastNewline = truncated.lastIndexOf("\n");
      conceptList = (lastNewline > 200 ? truncated.slice(0, lastNewline) : truncated)
        + `\n... (còn ${concepts.length} khái niệm khác đã học)`;
      console.warn(`[ConceptMemory] Truncated từ ${buildUsedConceptsBlock(concepts).length} → ${MAX_CONCEPT_BLOCK_CHARS} chars`);
    }

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

  const practiceNote = isPractice
    ? "\n- Với mỗi ví dụ: CHỈ dùng ví dụ CÓ SẴN trong CONTEXT, trích gần nguyên văn. KHÔNG tự đặt ví dụ mới."
    : "\n- Nếu CONTEXT không có ví dụ cụ thể: ghi rõ \"*(Tài liệu không cung cấp ví dụ cho điểm này)*\". KHÔNG tự bịa.";

  const wordTarget = isDeep
    ? `${budget.targetWords} từ — ưu tiên chiều sâu, KHÔNG mở rộng ngoài CONTEXT`
    : `${budget.targetWords} từ — súc tích, bám sát CONTEXT`;

  let modeInstructions;
  if (isDeep && isPractice) {
    modeInstructions = `
🎯 VAI TRÒ: EXTRACTOR — THỰC HÀNH CHUYÊN SÂU
Nhiệm vụ: trích xuất và trình bày lại chi tiết những gì ĐÃ CÓ trong CONTEXT. KHÔNG bổ sung kiến thức ngoài tài liệu.
- Cấu trúc: Vấn đề (từ CONTEXT) → Phân tích (từ CONTEXT) → Giải pháp (từ CONTEXT) → Trường hợp ngoại lệ (nếu CONTEXT đề cập)
- Từ số: ${wordTarget}
- Bài tập tư duy cuối bài: CHỈ đặt ra nếu CONTEXT có bài tập hoặc câu hỏi mẫu. Nếu không có, bỏ qua phần này.
- Giải thích "tại sao" CHỈ khi CONTEXT có lý giải rõ ràng. Nếu không: ghi "*(Tài liệu không giải thích lý do này)*".${practiceNote}`;
  } else if (isDeep) {
    modeInstructions = `
🎯 VAI TRÒ: EXTRACTOR — LÝ THUYẾT CHUYÊN SÂU
Nhiệm vụ: phân tích và trình bày lại chi tiết những gì ĐÃ CÓ trong CONTEXT. KHÔNG bổ sung kiến thức ngoài tài liệu.
- Cấu trúc: Định nghĩa (từ CONTEXT) → Nguyên lý (từ CONTEXT) → Phân tích (từ CONTEXT) → So sánh (nếu CONTEXT đề cập) → Ứng dụng (nếu CONTEXT đề cập)
- Từ số: ${wordTarget}
- "Tại sao?" hoặc "Khi nào không dùng?": CHỈ viết nếu CONTEXT có câu trả lời. Nếu không: ghi "*(Tài liệu không đề cập lý do hoặc giới hạn áp dụng)*".${practiceNote}`;
  } else if (isPractice) {
    modeInstructions = `
🎯 VAI TRÒ: EXTRACTOR — THỰC HÀNH CƠ BẢN
Nhiệm vụ: trình bày rõ ràng những gì ĐÃ CÓ trong CONTEXT. KHÔNG bổ sung kiến thức ngoài tài liệu.
- Từ số: ${wordTarget}${practiceNote}`;
  } else {
    modeInstructions = `
🎯 VAI TRÒ: EXTRACTOR — LÝ THUYẾT CƠ BẢN
Nhiệm vụ: trình bày rõ ràng những gì ĐÃ CÓ trong CONTEXT. KHÔNG bổ sung kiến thức ngoài tài liệu.
- Cấu trúc: Khái niệm (từ CONTEXT) → Ví dụ (từ CONTEXT nếu có) → Tóm tắt ghi nhớ
- Từ số: ${wordTarget}${practiceNote}`;
  }

  const sectionsListBlock = coveredSections.length > 0
    ? `
📌 CÁC TIÊU ĐỀ/CHỦ ĐỀ BẮT BUỘC PHẢI GIẢNG DẠY (MỤC LỤC BẮT BUỘC):
${coveredSections.map((s, idx) => `- Mục [${idx + 1}]: ${s}`).join("\n")}
=> Bắt buộc viết bài giảng chi tiết cho TẤT CẢ các mục trên dựa trên CONTEXT. Nếu CONTEXT không có nội dung cho một mục nào đó, ghi rõ: "*(Tài liệu không cung cấp nội dung cho mục này)*". Tuyệt đối không tự bịa để lấp đầy.`
    : "";

  // =========================
  // MAIN PROMPT
  // =========================
  const contentPrompt = `Bạn là một AI chuyên trích xuất và soạn thảo bài giảng học thuật đa lĩnh vực (Khoa học, Y tế, Luật pháp, Kinh tế, Lập trình, Database...).
Nhiệm vụ của bạn là soạn thảo một nội dung bài học dựa trên tài liệu được cung cấp.

${sectionsListBlock}

⚠️ QUY TẮC BẮT BUỘC (TUÂN THỦ TUYỆT ĐỐI):
1. VAI TRÒ TRỌNG TÂM LÀ EXTRACTOR thay vì GENERATOR (CẤM SUY DIỄN & BỊA ĐẶT):
   - KHÔNG tự suy luận, KHÔNG tự ý sáng tạo.
   - CHỈ sử dụng và giải thích các thông tin, định nghĩa, cú pháp, lệnh, tham số xuất hiện rõ ràng trong phần CONTEXT dưới đây.
   - Nếu tài liệu không mô tả chi tiết hoặc không giải thích rõ về một khía cạnh nào đó, hãy ghi rõ: "Tài liệu không đề cập nội dung này". Tuyệt đối KHÔNG được bổ sung kiến thức bên ngoài, KHÔNG được suy đoán hay tự ý sáng tạo dưới mọi hình thức.
2. KHÔNG TỰ TẠO VÍ DỤ MỚI:
   - KHÔNG tự  đưa ra ví dụ mới không có trong tài liệu
   - CHỈ trích xuất nguyên văn các ví dụ có sẵn trong CONTEXT.
   - Nếu CONTEXT không có ví dụ cụ thể, hãy trình bày bằng lý thuyết thuần túy trích xuất từ CONTEXT và ghi rõ: "Tài liệu không cung cấp ví dụ cụ thể cho trường hợp này."
3. KHÔNG LẶP LẠI BÀI CŨ: 
   - Xem kỹ phần "BÀI TRƯỚC (CẤM LẶP)" bên dưới. Không định nghĩa lại, không giảng dạy lại các chủ đề/khái niệm đã được dạy.
4. CẢI THIỆN ĐỊNH DẠNG & SỬA LỖI OCR:
   - CONTEXT có thể chứa lỗi trích xuất (dính chữ, thiếu dấu cách, xuống dòng lỗi). Hãy sửa thành tiếng Việt/văn bản chuẩn, mạch lạc.
5. TÍNH HOÀN THIỆN:
   - Ví dụ trong bài (công thức, đoạn trích, bảng biểu, mã, quy trình, sự kiện, định nghĩa...) PHẢI đầy đủ như trong CONTEXT — không rút gọn, không bỏ phần quan trọng, không dùng "..." thay nội dung.
   - KHÔNG dùng placeholder giả (example, param1, tên_của_bạn, ...) trừ khi có sẵn trong tài liệu.
6. TRÌNH BÀY SƯ PHẠM:
   - Cấu trúc: Mở đầu ngắn → Giải thích từng phần theo thứ tự → Minh họa ví dụ(nếu CONTEXT có ví dụ) → Tóm tắt ghi nhớ (3-6 bullet).
   - Mỗi mục/section CHỈ xuất hiện 1 lần — không lặp ở cuối bài.
   - CHỈ dạy nội dung thuộc phạm vi ngày hôm nay; không lấn sang phần của ngày khác.
   - Markdown (##, ###, bullet); giọng văn giáo trình, không copy-paste máy móc.
7. OUTPUT SẠCH:
   - KHÔNG ghi metadata hệ thống (Ngày, Bloom, Chủ đề, Mục tiêu) trong bài học.
   - KHÔNG thêm phần "Bổ sung" ngoài phạm vi.
   - Giữ nguyên thuật ngữ, tên riêng, ký hiệu, số liệu từ CONTEXT.
8. CHỐNG HALLUCINATION KỸ THUẬT VÀ HỌC THUẬT (QUAN TRỌNG):
   - Nếu CONTEXT nói "dùng X để làm Y" → dùng đúng X. CẤM tự ý đổi thành Z dù Z cũng làm được Y.
   - Số lượng tham số, tên bảng, tên cột, tên hàm, số liệu thực nghiệm: PHẢI khớp CHÍNH XÁC với CONTEXT.
9. ĐÁNH SỐ MỤC:
   - Giữ nguyên số mục (1.1, 2.3, ...) từ tài liệu gốc. KHÔNG tự đánh lại thành 1, 2, 3.
   - Heading trong bài PHẢI dùng số mục gốc từ coveredSections (ví dụ: "### 1.5 ...", "### 2.3 ...").



${conceptMemoryBlock}
${exampleHint}
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

YÊU CẦU OUTPUT:
- Markdown rõ ràng (##, ###, bullet)
- KHÔNG có quiz, JSON, giải thích meta
`;

  // =========================
  // GENERATOR
  // =========================
  const generateContent = async (temperature, extraInstruction = "") => {
    // Thử với context đầy đủ trước, nếu 413 thì cắt context xuống
    const contextLimits = [6500, 4000, 2500];

    for (const ctxLimit of contextLimits) {
      // Chỉ cắt lại nếu safeContext dài hơn limit hiện tại (retry do 413)
      const trimmedContext = safeContext.length > ctxLimit
        ? smartTruncateContext(safeContext, ctxLimit)
        : safeContext;
      const promptWithCtx = contentPrompt
        .replace(safeContext, trimmedContext);

      try {
        let content = await makeGroqPlainRequest({
          messages: [
            {
              role: "system",
              content: "Bạn viết bài giảng Markdown. TUÂN THỦ NGHIÊM NGẶT phạm vi. Không được phép sáng tạo ngoài dữ liệu. VAI TRÒ TRỌNG TÂM LÀ EXTRACTOR thay vì GENERATOR.",
            },
            {
              role: "user",
              content: promptWithCtx + "\n\n" + extraInstruction,
            },
          ],
          model: contentModel,
          temperature,
          maxTokens: budget.contentTokens,
        });

        // ... phần clean content giữ nguyên
        content = content
          .replace(/^```(?:markdown|md)?\n?/i, "")
          .replace(/\n?```$/i, "")
          .replace(/(<!--\s*image\s*-->\s*\n?){3,}/gi,
            "\n*(Tài liệu gốc có hình/công thức minh họa tại đây)*\n")
          .replace(/(<!--\s*image\s*-->\s*\n?){1,2}/gi,
            "*(hình minh họa)*\n")
          .trim();

        content = stripPromptLeakage(content);
        for (const marker of ["### Quiz", "## Quiz", "---\n**Quiz"]) {
          const idx = content.indexOf(marker);
          if (idx !== -1) content = content.slice(0, idx).trim();
        }
        content = content
          .split("\n")
          .filter(line => {
            const t = line.trim();
            if (/^\*\s*\[Context:/i.test(t)) return false;
            if (/^-\s*\[Context:/i.test(t)) return false;
            if (/^\[Context:/i.test(t)) return false;
            if (/^\[BẢNG DỮ LIỆU/i.test(t)) return false;
            return true;
          })
          .join("\n")
          .trim();

        return content;

      } catch (err) {
        const is413 = err?.status === 413 || /413|too large|request too large/i.test(String(err?.message || ""));
        if (is413 && ctxLimit > 2500) {
          console.warn(`[TokenTrim] 413 với ctxLimit=${ctxLimit} → thử lại với ${contextLimits[contextLimits.indexOf(ctxLimit) + 1]}`);
          continue; // thử lại với context ngắn hơn
        }
        throw err; // lỗi khác → throw bình thường
      }
    }

    throw new Error("Tất cả context limits đều thất bại");
  };


  try {
    // Ép temperature về 0.0 để tránh tối đa hallucination kỹ thuật ngẫu nhiên
    let content = await generateContent(0.0);

    // POST-GEN: polish deterministic (OCR + scope + dedup) — không gọi AI thêm
    content = stripInvalidCodeBlocks(content, safeContext);
    content = polishLessonContent(content, coveredSections);
    console.log(`[Polish] Day ${dayNumber} — OCR fix + scope strip + dedup`);

    const scopeResult = validateScopeCompliance(content, item, previousSummaries);
    if (!scopeResult.ok) {
      console.warn(`[ScopeGuard] Day ${dayNumber} violations:`, scopeResult.violations);
      content = polishLessonContent(content, coveredSections);
    }

    const dupResults = checkContentDuplication(content, previousSummaries);
    const highDup = dupResults.filter((d) => d.ratio > 65);
    if (highDup.length > 0) {
      console.warn(`[AntiDup] Day ${dayNumber} high overlap (giữ nguyên, không regenerate):`, highDup);
    }

    // Chỉ regenerate 1 lần khi nội dung quá ngắn sau polish
    if (content.length < 300) {
      console.warn(`[ContentTooShort] Day ${dayNumber} → regenerate 1 lần`);
      content = await generateContent(
        0.0,
        "Viết đầy đủ hơn, bám sát CONTEXT, không lặp mục, không thêm nội dung ngoài phạm vi."
      );
      content = stripInvalidCodeBlocks(content, safeContext);
      content = polishLessonContent(content, coveredSections);
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

// Phân phối outline thành từng khối LIÊN TIẼP cho mỗi ngày (slice, không phải round-robin)
// Ví dụ: outline=[1,2,3,4,5,6], 3 ngày → Ngày1=[1,2] / Ngày2=[3,4] / Ngày3=[5,6]
const distributeSections = (outline, numDays) => {
  if (!outline.length) return Array.from({ length: numDays }, () => []);
  const n = outline.length;
  return Array.from({ length: numDays }, (_, i) => {
    const start = Math.floor(i * n / numDays);
    const end = Math.floor((i + 1) * n / numDays);
    return outline.slice(start, end);
  });
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
  // FIX: Dùng lại extractDocumentOutline() thay vì tự parse heading
  // extractDocumentOutline đã có đầy đủ filter:
  //   - Loại tên chương tổng quát không có X.Y
  //   - Loại heading # cấp 1 không có số mục
  //   - Chỉ giữ số mục X.Y trở lên
  const uniqueHeadings = extractDocumentOutline(text);

  // Fallback nếu extractDocumentOutline trả về rỗng
  // (tài liệu không có heading nào hợp lệ)
  if (uniqueHeadings.length === 0) {
    return Array.from({ length: days }, (_, i) => {
      const bloom = getBloomLevel(i, days);
      const title = `Phần ${i + 1}/${days}`;
      return {
        dayNumber: i + 1,
        title,
        objective: `Nắm vững nội dung ${bloom.vi} — ${title}`,
        bloomLevel: bloom.label,
        coveredSections: [title],
      };
    });
  }

  // Phân bổ heading theo slice liên tiếp (giống distributeSections)
  // Tránh nhiều ngày cùng trỏ về 1 heading khi outline ít hơn số ngày
  return Array.from({ length: days }, (_, i) => {
    const bloom = getBloomLevel(i, days);

    const idx = Math.min(
      Math.floor((i * uniqueHeadings.length) / days),
      uniqueHeadings.length - 1
    );
    const title = uniqueHeadings[idx];

    return {
      dayNumber: i + 1,
      title,
      objective: `Nắm vững nội dung ${bloom.vi} — ${title}`,
      bloomLevel: bloom.label,
      coveredSections: [title],
    };
  });
};


// Thêm "chương", "bài", "unit", "module" vào blacklist
// Giúp cho mọi loại tài liệu (không chỉ SQL)
const GENERIC_TITLE_RE = /^(cơ sở dữ liệu|tổng quan|giới thiệu|introduction|overview|nội dung|bài học|chủ đề|khóa học|tài liệu|chương|chapter|phần|section|bài|unit|module)(\s|$)/i;
/**
 * Làm sạch và chuẩn hóa title AI trả về cho 1 ngày học.
 * - Strip ký tự đặc biệt: **, *, |, #, backtick
 * - Nếu có số mục X.Y → giữ số mục + 5 từ đầu
 * - Nếu title generic/không số mục → dùng section được phân công
 */
const cleanSyllabusTitle = (raw, assignedSections = [], dayIndex = 0) => {
  let t = String(raw || "")
    .replace(/\*+/g, "")
    .replace(/#+\s*/g, "")
    .replace(/[|`]/g, " ");

  // ✅ Xóa các chấm lửng mục lục OCR và số trang ở cuối
  t = t.replace(/\s*[.…_~-\s]+\s*\d+$/, "");
  t = t.replace(/\s*[.…_~-]+\s*$/, "");
  t = t.replace(/[.…]{2,}/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();

  const numMatch = t.match(/(\d+(?:\.\d+)+)\s+(.+)/);
  if (numMatch) {
    const rest = numMatch[2].trim();

    // ✅ Chỉ giữ phần MÔ TẢ CHỦ ĐỀ, KHÔNG kèm số mục (1.2, 1.4...)
    // → Tránh hiển thị "1.2 Stored Procedure" gây ấn tượng bỏ sót 1.1, 1.3
    // → Số mục vẫn được lưu trong coveredSections để RAG tìm đúng
    const cutAtPunct = rest.search(/[,;:()[\]-]/);
    const shortRest = cutAtPunct > 15
      ? rest.slice(0, cutAtPunct).trim()
      : rest.split(/\s+/).slice(0, 10).join(" ");

    return shortRest.slice(0, 100);
  }

  // Fallback về section được phân công — cũng strip số mục
  if ((GENERIC_TITLE_RE.test(t) || t.length < 8) && assignedSections.length > 0) {
    const numbered = assignedSections.find(s => /\d+\.\d+/.test(String(s)));
    if (numbered) {
      const strippedNum = String(numbered)
        .replace(/^\d+(?:\.\d+)+\s*/, "")  // bỏ số mục đầu
        .replace(/\s*[.…_~-\s]+\s*\d+$/, "")
        .replace(/\s*[.…_~-]+\s*$/, "")
        .slice(0, 100);
      // Nếu sau khi strip vẫn còn text có nghĩa → dùng
      if (strippedNum.length >= 5) return strippedNum;
    }
    return String(assignedSections[0])
      .replace(/^\d+(?:\.\d+)+\s*/, "")
      .replace(/\s*[.…_~-\s]+\s*\d+$/, "")
      .replace(/\s*[.…_~-]+\s*$/, "")
      .split(/\s+/)
      .slice(0, 10)
      .join(" ")
      .slice(0, 100);
  }

  return t.length > 100 ? t.split(/\s+/).slice(0, 10).join(" ") : t;
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
const SYLLABUS_TEXT_LIMIT = 8000;

// ✅ Lấy outline đầy đủ + sample content mỗi chương
const buildRepresentativeText = (text, limit = 8000) => {
  // Ưu tiên 1: Lấy toàn bộ các dòng heading (số mục X.Y)
  const headingLines = text.split(/\r?\n/)
    .filter(l => /^\d+\.\d+/.test(l.trim()) || /^#{1,3}\s+\d+\.\d+/.test(l.trim()))
    .join('\n');

  // Ưu tiên 2: Lấy 400 ký tự đầu mỗi section lớn
  const sections = text.split(/(?=\n\d+\.\d+\s|\n#{1,2}\s+\d+)/);
  const sampledSections = sections.map(s => s.slice(0, 400)).join('\n---\n');

  const combined = headingLines + '\n\n' + sampledSections;
  return combined.slice(0, limit);
};

const generateSyllabus = async (rawText, numDays, learningGoalsInput = null) => {
  const learningGoals = normalizeLearningGoals(learningGoalsInput || {});
  const textForOutline = mergeBrokenNumberedHeadings(rawText || "");
  const objectiveSeeds = getObjectiveSeedsFromText(textForOutline, numDays);
  const outline = extractDocumentOutline(textForOutline);

  // ─────────────────────────────────────────────
  // BƯỚC 1: Phân công trước — slice LIÊN TIẾP
  // ─────────────────────────────────────────────
  const distributedSections = distributeSections(outline, numDays);
  const fallbackPlan = buildFallbackPreviewPlan(textForOutline, numDays);

  // ─────────────────────────────────────────────
  // BƯỚC 2: Build prompt
  // ─────────────────────────────────────────────
  const outlineBlock = outline.length > 0
    ? outline.map((h, i) => `${i + 1}. ${h}`).join("\n")
    : "(Không nhận diện được outline — dùng text thô)";

  const breadthNote = outline.length > numDays
    ? `\nCHIẾN LƯỢC GỘP: ~${outline.length} phần / ${numDays} ngày → mỗi ngày gộp nhiều mục.`
    : "";

  const bloomHints = Array.from({ length: numDays }, (_, i) => {
    const bloom = getBloomLevel(i, numDays);
    return `Ngày ${i + 1} → ${bloom.vi} (${bloom.label})`;
  }).join("\n");

  const outlineAssignment = outline.length
    ? distributedSections.map((sections, i) =>
      sections.length
        ? `Ngày ${i + 1}: ${sections.join(" | ")}`
        : `Ngày ${i + 1}: (chia sâu từ phần gần nhất)`
    ).join("\n")
    : "";

  // Skeleton: buộc AI điền đúng số ngày
  const daySkeleton = Array.from({ length: numDays }, (_, i) =>
    `{"dayNumber":${i + 1},"title":"...","objective":"...","bloomLevel":"${getBloomLevel(i, numDays).label}","coveredSections":["..."]}`
  ).join(',\n');

  const syllabusPrompt = `Bạn là chuyên gia thiết kế chương trình học.
 
⚠️ BẮT BUỘC:
- Trả về ĐÚNG ${numDays} object trong mảng "syllabus" — KHÔNG được dừng sớm.
- Mỗi "title" PHẢI lấy từ số mục + tên section được phân công (ví dụ: "1.2 Stored Procedure cơ bản").
- KHÔNG đặt tiêu đề chung chung như "Cơ sở dữ liệu nâng cao", "Giới thiệu", "Tổng quan".
- KHÔNG lặp lại title giữa các ngày.
 
OUTLINE tài liệu:
${outlineBlock}
${breadthNote}
 
PHÂN CÔNG TỪNG NGÀY (BẮT BUỘC tuân theo):
${outlineAssignment}
 
MỤC TIÊU HỌC VIÊN: ${syllabusBiasInstructions(learningGoals)}
 
BLOOM từng ngày:
${bloomHints}
 
QUY TẮC NGHIÊM NGẶT:
1. title: Tên chủ đề ngắn gọn, KHÔNG có số mục — tối đa 8 từ, mô tả đúng nội dung ngày đó.
   - ĐÚNG: "Stored Procedure cơ bản", "Giao dịch và ACID", "Biến và câu lệnh điều kiện"
   - SAI: "1.1 Stored Procedure cơ bản", "Cơ sở dữ liệu nâng cao", "Giao dịch** | 1.1"
   - TUYỆT ĐỐI KHÔNG đặt số mục (1.1, 2.3...) vào trường title
   - TUYỆT ĐỐI KHÔNG dùng tên tài liệu/chương tổng quát làm title
   - TUYỆT ĐỐI KHÔNG có ký tự **, *, |, # trong title
2. coveredSections: PHẢI chứa đúng các section được phân công (có số mục, ví dụ: "1.2 Stored Procedure...").
3. objective: mô tả cụ thể sẽ học gì — KHÔNG dùng "tổng quan", "giới thiệu".
4. Mỗi ngày chỉ dạy phần đã được phân công — KHÔNG lấn sang ngày khác.
5. coveredSections KHÔNG được rỗng.
6. Hoàn thành toàn bộ một chương trước khi chuyển chương tiếp.
 
TRẢ VỀ JSON (điền đầy đủ ${numDays} ngày):
{
  "title": "...",
  "syllabus": [
${daySkeleton}
  ]
}`;

  // ─────────────────────────────────────────────
  // BƯỚC 3: Gọi AI
  // ─────────────────────────────────────────────
  // ✅ Dùng MODEL_SMART (70b) — sinh JSON ổn định hơn 8b với prompt có cấu trúc phức tạp
  // ✅ Áp dụng thuật toán buildRepresentativeText để giữ độ phủ (coverage) cho tài liệu dài nhiều chương
  const truncatedText = buildRepresentativeText(textForOutline, SYLLABUS_TEXT_LIMIT);

  let response;
  try {
    response = await makeGroqRequest({
      messages: [
        {
          role: "system",
          content: `Chỉ trả về JSON hợp lệ. KHÔNG dùng markdown code block. KHÔNG thêm text trước/sau.
Output phải bắt đầu bằng { và kết thúc bằng }.
Ví dụ đúng: {"title":"...","syllabus":[...]}
Ví dụ SAI: \`\`\`json{"title":"..."}\`\`\``
        },
        {
          role: "user",
          content: syllabusPrompt + "\n\nTEXT:\n" + truncatedText
        }
      ],
      model: MODEL_SMART,
      temperature: 0.1,
      maxTokens: Math.max(1500, numDays * 300),
      enforceJSON: true,
    });
  } catch (err) {
    console.warn("[generateSyllabus] AI call failed:", err.message, "→ dùng fallback");
    return {
      title: fallbackPlan[0]?.title || "Khóa học tự động",
      syllabus: fallbackPlan,
    };
  }

  // ─────────────────────────────────────────────
  // BƯỚC 3.5: Parse + validate sớm
  // ─────────────────────────────────────────────
  let data;
  try {
    // Phát hiện sớm AI trả về prose thay vì JSON
    const trimmed = String(response || "").trimStart();
    const hasJsonStart = trimmed.includes("{") || trimmed.includes("[");
    if (!hasJsonStart) {
      console.warn(`[Syllabus] AI trả về pure prose, không có JSON → fallback`);
      throw new Error("AI returned prose instead of JSON");
    }
    // safeJSONParse đã tự strip backtick + preamble
    data = safeJSONParse(response);
  } catch (e) {
    console.warn("[Syllabus] JSON parse lỗi → fallback:", e.message);
  }

  if (!data || !Array.isArray(data.syllabus) || data.syllabus.length === 0) {
    console.warn("[Syllabus] Dữ liệu không hợp lệ → dùng fallback toàn bộ");
    return {
      title: fallbackPlan[0]?.title || "Khóa học tự động",
      syllabus: fallbackPlan,
    };
  }

  // Trim thừa ngay từ đầu
  if (data.syllabus.length > numDays) {
    console.warn(`[Syllabus] AI trả về ${data.syllabus.length} ngày → cắt xuống ${numDays}`);
    data.syllabus = data.syllabus.slice(0, numDays);
  }

  // ─────────────────────────────────────────────
  // BƯỚC 4: Post-process từng ngày
  // ─────────────────────────────────────────────
  const usedTitles = new Set();
  const usedObjectives = new Set();

  const syllabus = data.syllabus.map((item, i) => {
    const bloom = getBloomLevel(i, numDays);

    // ── TITLE ─────────────────────────────────
    // cleanSyllabusTitle: strip ký tự đặc biệt, enforce số mục, fallback về section
    let title = cleanSyllabusTitle(
      item.title || "",
      distributedSections[i] || [],
      i
    );

    // Enforce unique: thay số mục nếu trùng
    let titleKey = normalizeTitle(title).replace(/\d/g, "").trim() || `ngay_${i + 1}`;
    if (usedTitles.has(titleKey)) {
      const assignedSections = distributedSections[i] || [];
      const altSection = assignedSections.find(s => /\d+\.\d+/.test(String(s)));
      const altNum = altSection
        ? (String(altSection).match(/^(\d+(?:\.\d+)+)/) || [])[1]
        : null;

      if (altNum) {
        title = title.replace(/^\d+(?:\.\d+)+\s*/, `${altNum} `).trim();
      } else {
        title = `${title.replace(/\s*\(\d+\)$/, "")} (${i + 1})`;
      }
      titleKey = normalizeTitle(title).replace(/\d/g, "").trim() || `ngay_${i + 1}`;
    }
    usedTitles.add(titleKey);

    // ── OBJECTIVE ─────────────────────────────
    let objective = normalizeSpace(item.objective || "");
    const objKey = objective.slice(0, 60).toLowerCase();
    const objGeneric =
      !objective ||
      objective.length < 20 ||
      /(tổng quan|giới thiệu|overview|introduction)/i.test(objective) ||
      usedObjectives.has(objKey);

    if (objGeneric) {
      objective = objectiveSeeds[i] || `Nắm vững nội dung ${bloom.vi} ngày ${i + 1}.`;
    }
    usedObjectives.add(objective.slice(0, 60).toLowerCase());

    // ── COVERED SECTIONS ──────────────────────
    let coveredSections = (item.coveredSections || [])
      .map(s => normalizeSpace(String(s)))
      .filter(s => s.length > 3);

    const hasNumbered = coveredSections.some(s => /\d+\.\d+/.test(s));

    if (hasNumbered && outline.length > 0) {
      // Remap số mục AI → heading đúng trong outline
      coveredSections = coveredSections.map(aiSection => {
        const aiNum = (String(aiSection).match(/^(\d+(?:\.\d+)+)/) || [])[1];
        if (!aiNum) return aiSection;
        const exactMatch = outline.find(h => {
          const hNum = (String(h).match(/^(\d+(?:\.\d+)+)/) || [])[1];
          return hNum === aiNum;
        });
        return exactMatch || aiSection;
      });
      coveredSections = [...new Set(coveredSections)];
    } else if (!hasNumbered && distributedSections[i]?.length) {
      coveredSections = distributedSections[i];
      console.log(`[Syllabus] Day ${i + 1}: dùng distributedSections`, coveredSections);
    }

    // Fallback cuối nếu vẫn rỗng
    if (coveredSections.length === 0) {
      if (distributedSections[i]?.length) {
        coveredSections = distributedSections[i];
      } else if (outline.length > 0) {
        coveredSections = [outline[i % outline.length]];
      } else {
        coveredSections = [title || `Nội dung ngày ${i + 1}`];
      }
      console.log(`[Syllabus] Day ${i + 1}: auto-fill sections`, coveredSections);
    }

    return {
      dayNumber: item.dayNumber || i + 1,
      title,
      objective,
      bloomLevel: item.bloomLevel || bloom.label,
      coveredSections,
    };
  });

  // ─────────────────────────────────────────────
  // BƯỚC 5: Coverage check — phân bổ đều, không dồn vào ngày cuối
  // ─────────────────────────────────────────────
  if (outline.length > 0) {
    const coveredSet = new Set(
      syllabus.flatMap(s => s.coveredSections.map(c => normalizeVN(c).slice(0, 30)))
    );

    const uncovered = outline.filter(sec => {
      const key = normalizeVN(sec).slice(0, 30);
      return key.length > 4 && !coveredSet.has(key);
    });

    if (uncovered.length > 0) {
      console.warn(`[Coverage] Bổ sung ${uncovered.length} sections bị thiếu`);
      uncovered.forEach(sec => {
        const targetDay = syllabus.reduce((min, day) =>
          day.coveredSections.length < min.coveredSections.length ? day : min
          , syllabus[0]);

        if (!targetDay.coveredSections.includes(sec)) {
          targetDay.coveredSections.push(sec);
          console.log(`[Coverage] Gán "${sec.slice(0, 40)}" → Day ${targetDay.dayNumber}`);
        }
      });
    }
  }

  // ─────────────────────────────────────────────
  // BƯỚC 6: Chống trộn chương — mỗi ngày chỉ 1 chương chính
  // ─────────────────────────────────────────────
  const outlineHasNumbered = outline.some(s => /^\d+\./.test(s));
  if (outlineHasNumbered) {
    syllabus.forEach((day, i) => {
      const majorChapters = new Set(
        day.coveredSections
          .map(s => (String(s).match(/^(\d+)\./) || [])[1])
          .filter(Boolean)
      );

      if (majorChapters.size > 1) {
        const firstChapter = [...majorChapters][0];
        const filtered = day.coveredSections.filter(s => {
          const major = (String(s).match(/^(\d+)\./) || [])[1];
          return !major || major === firstChapter;
        });
        if (filtered.length > 0) {
          console.warn(`[ChapterGuard] Day ${i + 1}: loại chương lẫn lộn`, [...majorChapters]);
          day.coveredSections = filtered;
        }
      }
    });
  }

  // ─────────────────────────────────────────────
  // BƯỚC 7: Pad / trim về đúng numDays
  // ─────────────────────────────────────────────
  if (syllabus.length < numDays) {
    console.warn(`[Syllabus] Thiếu ${numDays - syllabus.length} ngày → pad bằng fallback`);
    for (let i = syllabus.length; i < numDays; i++) {
      const bloom = getBloomLevel(i, numDays);
      syllabus.push(
        fallbackPlan[i] || {
          dayNumber: i + 1,
          title: `Nội dung ngày ${i + 1}`,
          objective: `Nắm vững nội dung ${bloom.vi} ngày ${i + 1}.`,
          bloomLevel: bloom.label,
          coveredSections: [outline[i % Math.max(outline.length, 1)] || `Phần ${i + 1}`],
        }
      );
    }
  } else if (syllabus.length > numDays) {
    syllabus.length = numDays;
  }

  // Chuẩn hóa dayNumber sau pad/trim
  syllabus.forEach((item, i) => { item.dayNumber = i + 1; });

  return { title: data.title || fallbackPlan[0]?.title || "Khóa học", syllabus };
};
// ─────────────────────────────────────────────────────────────────────────────
// 📦 HÀM 2: CẮT NHỏ TÀI LIỆU & LƯU TRỮ VECTOR (processAndStoreDocument)
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
const processAndStoreDocument = async (planId, text) => {
  const normalizedText = mergeBrokenNumberedHeadings(String(text || ""));
  const cleaned = cleanText(normalizedText);
  const rawChunks = chunkText(cleaned);

  if (!rawChunks.length) {
    console.warn("[Chunk] Không có chunk nào.");
    return;
  }

  // ── TOPIC CLASSIFICATION (chạy đồng bộ, không tốn token) ──────
  const chunks = classifyChunks(rawChunks);

  // Xóa sạch chunks cũ để tránh duplicate
  await Chunk.deleteMany({ planId });

  // Bước 1: Chuẩn bị Parent Chunks với _id ổn định để child chunks trỏ đúng parent.
  const parentDocsToInsert = chunks.map((c, idx) => ({
    _id: new mongoose.Types.ObjectId(),
    planId,
    content: String(c.content || "")
      .replace(/(<!--\s*image\s*-->\s*\n?){3,}/gi,
        "*(công thức/hình minh họa — xem tài liệu gốc)*\n")
      .replace(/(<!--\s*image\s*-->\s*\n?){1,2}/gi, "")
      .slice(0, 3000),
    section: sanitizeSectionName(c.section || ""),
    topic: c.topic || "general",
    chunkIndex: c.index ?? idx,
    isChild: false,
    parentId: null,
    metadata: {
      wordCount: c.wordCount || String(c.content || "").split(" ").length,
    },
    embedding: []
  }));

  // Bước 2: Tạo Proposition Child Chunks liên kết với các Parent đã có _id.
  const childDocsToInsert = [];
  parentDocsToInsert.forEach((parent) => {
    const propositions = splitIntoPropositions({
      content: parent.content,
      section: parent.section
    });

    propositions.forEach((prop) => {
      childDocsToInsert.push({
        planId,
        content: prop.content,
        section: parent.section,
        topic: parent.topic,
        chunkIndex: parent.chunkIndex,
        isChild: true,
        parentId: parent._id,
        metadata: {
          wordCount: prop.wordCount,
        },
        embedding: []
      });
    });
  });

  // Gộp tất cả Parent và Child Chunks
  const allDocs = [...parentDocsToInsert, ...childDocsToInsert];

  console.log(`📂 [Parent-Child RAG] Ingestion: ${parentDocsToInsert.length} parent chunks | ${childDocsToInsert.length} child chunks.`);

  // ──── EMBEDDING (Embedding) ──────────────────────────────────────────────
  const requestedConcurrency = Number(process.env.EMBEDDING_CONCURRENCY || 2);
  const concurrency = Math.max(1, Math.min(3, requestedConcurrency));

  const results = new Array(allDocs.length);
  let index = 0;

  const worker = async () => {
    while (true) {
      const i = index++;
      if (i >= allDocs.length) break;

      const doc = allDocs[i];

      try {
        // ✅ FIX: Chỉ stagger khi dùng external embedding API, không stagger local model
        const isExternalEmbeddingAPI = Boolean(
          process.env.EMBEDDING_API_URL ||   // URL custom API
          process.env.VOYAGE_API_KEY ||       // Voyage AI
          process.env.OPENAI_API_KEY          // OpenAI embeddings
        );
        if (i > 0 && isExternalEmbeddingAPI) await sleep(EMBEDDING_STAGGER_MS);

        const embedding = await retryWithBackoff(
          () => generateEmbedding(doc.content, "passage"),
          3
        );

        if (!embedding || embedding.length === 0) {
          continue;
        }

        results[i] = {
          ...(doc._id ? { _id: doc._id } : {}),
          planId: doc.planId,
          content: doc.content,
          embedding,
          chunkIndex: doc.chunkIndex,
          section: doc.section,
          topic: doc.topic,
          isChild: doc.isChild,
          parentId: doc.parentId,
          metadata: doc.metadata
        };

      } catch (err) {
        console.error(`[Embedding Doc ${i}] error:`, err.message);
      }
    }
  };

  // chạy workers sinh embedding song song
  await Promise.all(
    Array.from({ length: Math.min(concurrency, allDocs.length) }, () => worker())
  );

  const docsToInsert = results.filter(Boolean);

  if (!docsToInsert.length) {
    console.warn("[Embedding] Không có chunk hợp lệ nào được sinh embedding.");
    return;
  }

  // Sắp xếp theo thứ tự đọc ban đầu
  docsToInsert.sort((a, b) => a.chunkIndex - b.chunkIndex);

  // Ghi debug chunks ra file để theo dõi nội dung chunk parent/child
  try {
    fs.mkdirSync(path.dirname(DEBUG_CHUNKS_PATH), { recursive: true });
    const debugDocs = docsToInsert.map((doc) => ({
      _id: doc._id,
      planId: doc.planId,
      chunkIndex: doc.chunkIndex,
      section: doc.section,
      topic: doc.topic,
      isChild: doc.isChild,
      parentId: doc.parentId,
      wordCount: doc.metadata?.wordCount || 0,
      contentSnippet: String(doc.content || "").slice(0, 1200),
    }));
    fs.writeFileSync(
      DEBUG_CHUNKS_PATH,
      JSON.stringify({ generatedAt: new Date().toISOString(), count: debugDocs.length, chunks: debugDocs }, null, 2),
      "utf-8"
    );
    console.log(`🧪 Debug saved: ${path.basename(DEBUG_CHUNKS_PATH)}`);
  } catch (err) {
    console.warn("⚠️ Không thể lưu debug chunk:", err.message);
  }

  // 🔥 insert theo batch
  const BATCH_SIZE = 50;
  for (let i = 0; i < docsToInsert.length; i += BATCH_SIZE) {
    const batch = docsToInsert.slice(i, i + BATCH_SIZE);
    try {
      await Chunk.insertMany(batch, { ordered: false });
    } catch (err) {
      console.error("[DB] Batch insert parent-child chunks lỗi:", err.message);
    }
  }

  console.log(`[Embedding] Đã lưu thành công ${docsToInsert.length} chunks (gồm cả Parent và Child).`);
};

/**
 * 🔥 Fix 1: Coverage-Aware Retrieval - Nạp thêm các parent chunks kế cận (chunkIndex + 1, chunkIndex + 2)
 * để đảm bảo tính liên kết kiến thức, không bỏ sót các phần liền sau (ví dụ break/continue sau for/while).
 */const expandChunksWithNeighbors = async (planId, chunks, expandCount = 2) => {
  if (!chunks || chunks.length === 0) return [];

  const expanded = [...chunks];
  const existingIndexes = new Set();
  const neighborIndexes = new Set();

  for (const chunk of chunks) {
    if (chunk.chunkIndex !== undefined && !chunk.isChild) {
      existingIndexes.add(chunk.chunkIndex);
    }
  }

  // Build map chunkIndex → major chapter
  const indexToChapter = new Map();
  for (const chunk of chunks) {
    if (chunk.isChild || chunk.chunkIndex === undefined) continue;
    const sec = String(chunk.section || "");
    const majorChapter = (sec.match(/^(\d+)\./) || [])[1] || null;
    if (majorChapter) {
      indexToChapter.set(chunk.chunkIndex, majorChapter);
    }
  }

  // ✅ FIX bổ sung: Tập tất cả chapter đang dạy (dùng cho fallback khi chunk gốc không có section)
  const activeChapters = new Set(
    [...indexToChapter.values()].filter(Boolean)
  );

  for (const chunk of chunks) {
    if (chunk.isChild) continue;
    if (chunk.chunkIndex === undefined) continue;
    const chunkChapter = indexToChapter.get(chunk.chunkIndex) || null;

    for (let i = 1; i <= expandCount; i++) {
      const after = chunk.chunkIndex + i;
      const before = chunk.chunkIndex - i;

      if (!existingIndexes.has(after)) neighborIndexes.add({ idx: after, chapter: chunkChapter });
      if (before >= 0 && !existingIndexes.has(before)) neighborIndexes.add({ idx: before, chapter: chunkChapter });
    }
  }

  if (neighborIndexes.size > 0) {
    const neighborIdxList = [...neighborIndexes].map(n => n.idx);
    const idxToChapter = new Map([...neighborIndexes].map(n => [n.idx, n.chapter]));

    const neighbors = await Chunk.find({
      planId,
      chunkIndex: { $in: neighborIdxList },
      isChild: false
    }).lean();

    for (const neighbor of neighbors) {
      if (existingIndexes.has(neighbor.chunkIndex)) continue;

      const requiredChapter = idxToChapter.get(neighbor.chunkIndex);
      const neighborSec = String(neighbor.section || "");
      const neighborChapter = (neighborSec.match(/^(\d+)\./) || [])[1] || null;

      if (requiredChapter !== null) {
        // ✅ Chunk gốc có section → kiểm tra chapter khớp
        if (neighborChapter && neighborChapter !== requiredChapter) {
          console.log(
            `[ExpandGuard] Bỏ qua neighbor idx=${neighbor.chunkIndex} ` +
            `(chương ${neighborChapter} ≠ yêu cầu ${requiredChapter})`
          );
          continue;
        }
      } else if (activeChapters.size > 0) {
        // ✅ FIX bổ sung: Chunk gốc không có section nhưng tài liệu CÓ đánh số chapter
        // → dùng activeChapters làm boundary
        if (neighborChapter && !activeChapters.has(neighborChapter)) {
          console.log(
            `[ExpandGuard] Bỏ qua neighbor idx=${neighbor.chunkIndex} ` +
            `(chương ${neighborChapter} ngoài tập đang dạy: ${[...activeChapters].join(",")})`
          );
          continue;
        }
      }
      // Tài liệu không đánh số (activeChapters rỗng) → thêm tự do

      expanded.push(neighbor);
      existingIndexes.add(neighbor.chunkIndex);
    }
  }

  return expanded.sort((a, b) => a.chunkIndex - b.chunkIndex);
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
//   B1: Xác định Persona từ profile.depth (basic → rõ ràng dễ hiểu / deep → phân tích sâu)
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

    // Persona dựa trên profile.depth từ form UI (basic / deep)
    // Không còn dùng getLearningMode vì UI mới không có REMEDIAL/NORMAL/ADVANCED
    const personaMap = {
      basic: "Giảng dạy rõ ràng, ngôn ngữ dễ hiểu, mỗi đoạn tập trung một ý chính.",
      deep: "Phân tích sâu, liên hệ giữa các khái niệm, nêu cạm bẫy thường gặp và edge cases.",
    };
    const selectedPersona = personaMap[profile.depth] || personaMap.basic;

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
    // RAG PIPELINE — ưu tiên section search (không cần HyDE khi có coveredSections)
    // ─────────────────────────────

    const coveredSectionsList = item.coveredSections || [];
    // ─────────────────────────────
    // RAG PIPELINE
    // ─────────────────────────────
    let queryVector = null;
    let contextChunks = [];

    try {
      if (coveredSectionsList.length > 0) {
        contextChunks = await searchChunksBySection(
          planId,
          coveredSectionsList,
          null,
          CHUNK_SEARCH_K,
          6000
        );
      }

      if (!contextChunks.length && coveredSectionsList.length > 0) {
        console.warn("[RAG] Section filter rỗng → multi-query fallback theo từng section");
        const sectionChunks = [];
        for (const section of coveredSectionsList.slice(0, 4)) {
          try {
            const sectionVec = await generateEmbedding(`passage: ${section}`, "query");
            const hits = await searchRelevantChunks(planId, sectionVec, 3);
            sectionChunks.push(...hits);
          } catch (e) { /* skip */ }
        }
        const seen = new Set();
        const dedupedChildren = sectionChunks.filter(c => {
          if (seen.has(c.chunkIndex)) return false;
          seen.add(c.chunkIndex);
          return true;
        });
        contextChunks = await expandToParentChunks(planId, dedupedChildren);
      }

      if (!contextChunks.length) {
        try {
          const queryText = `${searchTopic}. ${objective || ""}`;
          queryVector = await generateEmbedding(`passage: ${queryText}`, "query");
        } catch (err) {
          console.warn("[RAG] embedding failed:", err.message);
        }
        console.warn("[RAG] fallback → vector search toàn cục");
        const raw = await searchRelevantChunks(planId, queryVector, CHUNK_SEARCH_K);
        contextChunks = await expandToParentChunks(planId, raw);
      }
    } catch (err) {
      console.error("[RAG] search failed:", err.message);
    }

    // ✅ FIX: expand neighbors TRƯỚC, filter section SAU
    // Lý do: filterChunksByCoveredSections loại chunk không khớp section,
    // nhưng neighbor hợp lệ (cùng chương) cũng bị loại oan nếu filter chạy trước.
    contextChunks = await expandChunksWithNeighbors(planId, contextChunks, 2);
    contextChunks = filterChunksByCoveredSections(contextChunks, coveredSectionsList);

    // ─────────────────────────────
    // CHUNK FILTER + DEDUP
    // ─────────────────────────────
    let selectedChunks;

    if (coveredSectionsList.length > 0) {
      // ✅ FIX: filter scope TRƯỚC, expand parent SAU
      // Lý do: expandToParentChunks có thể kéo parent ngoài coveredSections vào
      const filteredFirst = filterChunksByCoveredSections(contextChunks, coveredSectionsList);

      // Bước 1: expand child → parent (trên tập đã lọc scope)
      const parentChunks = await expandToParentChunks(planId, filteredFirst);

      // Bước 2: filter scope lần 2 — loại parent ngoài scope bị kéo vào qua expandToParentChunks
      const scopedParents = filterChunksByCoveredSections(parentChunks, coveredSectionsList);

      // Bước 3: lọc chunk quá ngắn + đã dùng
      selectedChunks = scopedParents
        .filter(c => {
          const sig = getChunkSignature(c.content);
          if (usedChunkSignatures.includes(sig)) return false;
          if (String(c.content || '').trim().length < 80) return false;
          return true;
        })
        .slice(0, CHUNK_USE_K);

      // Fallback nhẹ: bỏ filter usedChunk
      if (!selectedChunks.length) {
        selectedChunks = filterOutTocChunks(scopedParents)
          .filter(c => String(c.content || '').trim().length >= 80)
          .slice(0, CHUNK_USE_K);
      }

      if (!selectedChunks.length) {
        selectedChunks = filterOutTocChunks(scopedParents).slice(0, CHUNK_USE_K);
      }
    } else {
      const parentChunks = await expandToParentChunks(planId, contextChunks);

      const scoredChunks = filterChunksByScore(parentChunks, CHUNK_SCORE_THRESHOLD, 2);
      selectedChunks = selectDiverseChunks(scoredChunks, usedChunkSignatures, CHUNK_USE_K);

      if (!selectedChunks.length && parentChunks.length > 0) {
        selectedChunks = filterOutTocChunks(parentChunks).slice(0, 2);
      }
    }

    // Fallback khẩn cấp: vẫn rỗng sau tất cả
    if (!selectedChunks || selectedChunks.length === 0) {
      console.warn(`[RAG Fallback] Vẫn rỗng → vector search khẩn cấp`);
      try {
        if (!queryVector) {
          const queryText = `${searchTopic}. ${objective || ""}`;
          queryVector = await generateEmbedding(`passage: ${queryText}`, "query");
        }
        const fallbackRaw = await searchRelevantChunks(planId, queryVector, 5);
        const fallbackParents = await expandToParentChunks(planId, fallbackRaw);
        selectedChunks = filterOutTocChunks(fallbackParents)
          .filter(c => String(c.content || '').trim().length >= 80)
          .slice(0, 3);
        if (!selectedChunks.length && fallbackParents.length > 0) {
          selectedChunks = filterOutTocChunks(fallbackParents).slice(0, 2);
        }
      } catch (err) {
        console.error("[RAG Fallback] Lỗi tìm kiếm khẩn cấp:", err.message);
      }
    }
    const currentChunkSigs = selectedChunks.map((c) =>
      getChunkSignature(c.content)
    );

    // ─────────────────────────────
    // CONTEXT BUILD (SAFE)
    // ─────────────────────────────

    let context = selectedChunks.length
      ? fixOcrGluedWords(selectedChunks.map((c) => c.content).join("\n---\n"))
      : "Không có context.";

    context = smartTruncateContext(context, 6500, 600);

    // ✅ CHỐNG MẤT HÌNH/CÔNG THỨC: thay marker bằng placeholder văn bản dễ nhận diện
    context = context
      .replace(/(<!--\s*image\s*-->\s*\n?){2,}/gi,
        "*(Tài liệu gốc có hình minh họa/công thức tại đây — không có văn bản thay thế)*\n")
      .replace(/<!--\s*image\s*-->/gi,
        "*(hình minh họa)*");

    // ✅ CHỐNG HALLUCINATION: cảnh báo khi context quá nghèo nàn
    const contextIsEmpty = !selectedChunks.length;
    const contextIsThin = selectedChunks.length > 0 && context.replace(/\s/g, "").length < 300;
    if (contextIsEmpty) {
      console.warn(`[Anti-Hallucination] Day ${dayNumber}: context RỖNG — AI có thể hallucinate. Kiểm tra lại chunks cho planId=${planId}`);
      context = `[CẢNH BÁO: Tài liệu gốc không có đủ nội dung cho chủ đề này. Chỉ trình bày những gì bạn biết chắc chắn từ context bên dưới, KHÔNG được bịa thêm.]

Không có context.`;
    } else if (contextIsThin) {
      console.warn(`[Anti-Hallucination] Day ${dayNumber}: context RẤT NGẮN (${context.replace(/\s/g, '').length} ký tự) — tăng cảnh giác hallucination`);
      context = `[CẢNH BÁO: Nội dung tài liệu gốc cho phần này rất hạn chế. Chỉ giảng dạy dựa trên các thông tin dưới đây, KHÔNG mở rộng bằng kiến thức ngoài tài liệu.]

${context}`;
    }
    // ✅ Lọc formulaNotes theo scope của ngày học (tránh lấn sân nội dung ngày khác)
    const coveredSections = item?.coveredSections || [];
    const formulaNotesFromContext = filterNotesByScope(
      extractFormulaLikeNotes(context),
      coveredSections
    );

    const codeIdentifiersFromContext = extractContextTerms(context);

    // ✅ FIX: Trích xuất các sự kiện/phân loại quan trọng để AI không bỏ sót
    const keyFactsFromContext = extractKeyFacts(context);

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
      previousSummaries,
      dayNumber: item.day,
      totalDays,
      item,
      usedConcepts: usedConcepts || [],  // ← concept memory
    });

    // ─────────────────────────────────────────────────────────────────────
    // ⚡ LAZY QUIZ: Bỏ qua Phase 2 (quiz) khi tạo khóa học
    // Quiz sẽ được tạo ON-DEMAND khi học viên lần đầu mở bài học.
    // Mục đích: Giảm 40-50% thời gian tạo khóa học.
    // ─────────────────────────────────────────────────────────────────────

    // ── POST-PROCESS: Loại bỏ nội dung AI viết sai scope ─────────────────
    // Ví dụ: AI tự thêm "### 2.3 Giao dịch" vào bài ngày 1 dù không được phép
    //let scopedContent = stripOutOfScopeHeadings(lessonContent, coveredSectionsList);

    // Bỏ Fact Verification Pass theo yêu cầu của học viên
    // Sau khi có lessonContent, thêm lại verify nhưng chỉ chạy khi content ngắn bất thường
    const MIN_CONTENT_LENGTH = 800;
    let scopedContent = stripOutOfScopeHeadings(lessonContent, coveredSectionsList);

    // Bỏ qua verify nếu Phase1 fail và trả về fallback string
    const isPhase1Fallback = scopedContent.includes("Nội dung đang được cập nhật từ tài liệu gốc");

    if (!isPhase1Fallback) {
      // Fix 1: verify dựa trên tỉ lệ content/context
      const contextWordCount = String(context || "").replace(/\s+/g, " ").split(" ").length;
      const contentWordCount = scopedContent.replace(/\s+/g, " ").split(" ").length;
      const expansionRatio = contentWordCount / Math.max(contextWordCount, 1);

      const shouldVerify =
        expansionRatio > 1.8          // content phình to bất thường → nghi hallucinate
        && contextWordCount > 150     // context đủ dày để AI verify có cơ sở đối chiếu
        && coveredSectionsList.length > 0 // chỉ verify khi có danh sách section rõ ràng
        && !contextIsThin;            // context mỏng → verify vô nghĩa, bỏ qua

      if (shouldVerify) {
        console.warn(
          `[Verify] Chạy verify: ratio=${expansionRatio.toFixed(2)}, ` +
          `contextWords=${contextWordCount}, contentWords=${contentWordCount}`
        );
        try {
          const verified = await verifyLessonContent(
            scopedContent,
            context,
            MODEL_FAST,
            coveredSectionsList
          );
          if (verified.correctedContent && verified.correctedContent.length > 100) {
            scopedContent = verified.correctedContent;
            if (verified.hallucinations?.length > 0) {
              console.warn(`[Verify] Phát hiện ${verified.hallucinations.length} chỗ sai:`, verified.hallucinations);
            }
          }
        } catch (e) {
          console.warn("[Verify] Skipped:", e.message);
        }
      }
    } else {
      console.warn(`[Verify] Bỏ qua verify vì Phase1 trả về fallback string`);
    }
    // Tạo summary nhanh từ chính content (không gọi AI thêm)
    const quickSummary = objective || `Bài học về ${searchTopic}`;
    const importantNotes = extractNotesFromMarkdown(scopedContent);
    // Chuẩn hóa nội dung bài học (không có quiz)
    const data = normalizeLessonData(
      {
        content: scopedContent,   // ← dùng scopedContent đã kiểm duyệt
        importantNotes,   // Sẽ được sinh khi tạo quiz on-demand
        summary: quickSummary,
        quiz: [],             // Rỗng — sẽ được sinh khi học viên mở bài lần đầu
      },
      objective,
      formulaNotesFromContext,
      searchTopic,
      quizBounds,
      practiceBias,
      { allowHeuristicFallback: false }
    );

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




const expandToParentChunks = async (planId, chunks) => {
  if (!chunks || chunks.length === 0) return [];

  // Tách ra: chunk nào đã là parent, chunk nào là child cần lookup parent
  const parentChunks = chunks.filter(c => !c.isChild);
  const childChunks = chunks.filter(c => c.isChild && c.parentId);

  if (childChunks.length === 0) return parentChunks;

  // Lấy tất cả parentId duy nhất từ child chunks
  const parentIds = [...new Set(childChunks.map(c => String(c.parentId)))];

  const parents = await Chunk.find({
    _id: { $in: parentIds },
    planId,
    isChild: false
  }).lean();

  // Merge + dedup theo _id
  const seen = new Set(parentChunks.map(c => String(c._id)));
  for (const p of parents) {
    if (!seen.has(String(p._id))) {
      parentChunks.push(p);
      seen.add(String(p._id));
    }
  }

  return parentChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
};
// ─────────────────────────────────────────────────────────────────────────────
// ⚡ HÀM ON-DEMAND: SINH QUIZ KHI HỌC VIÊN MỞ BÀI HỌC (generateQuizForLesson)
//
// Mục đích: Được gọi từ Controller khi học viên lần đầu mở một bài học.
//           Sinh quiz + importantNotes từ nội dung bài học đã có sẵn.
//
// Tham số:
//   - lesson       : Document Lesson từ MongoDB (có lesson.content, lesson.title)
//   - learningGoals: Mục tiêu học {focus, depth} của học viên
// Trả về:
//   { quiz: [...], importantNotes: [...], summary: "..." }
// ─────────────────────────────────────────────────────────────────────────────
const generateQuizForLesson = async (lesson, learningGoals = {}) => {
  const profile = normalizeLearningGoals(learningGoals);
  const quizBounds = getQuizBounds(profile);
  const practiceBias = profile.focus === "practice";

  const searchTopic = lesson.title || "Bài học";
  const objective = lesson.summary || "";
  // Dùng chính content bài học làm context để tạo quiz — không cần RAG lại
  const context = String(lesson.content || "").slice(0, 6000);

  // Lọc theo coveredSections nếu có (nhất quán với generateScientificLesson)
  const coveredSections = lesson.coveredSections || [];
  const formulaNotes = filterNotesByScope(
    extractFormulaLikeNotes(context),
    coveredSections
  );

  let metaData = { importantNotes: [], summary: objective, quiz: [] };

  // Gọi AI sinh quiz + importantNotes
  try {
    if (typeof generateLessonMeta === "function") {
      const metaRaw = await retryWithBackoff(() => generateLessonMeta({
        context,
        searchTopic,
        objective,
        bloomLevel: lesson.bloomLevel || "Understand",
        quizBounds,
        profile,
        formulaNotes,
        totalDays: 1,  // không cần context toàn khóa
      }));
      const parsed = safeJSONParse(metaRaw);
      if (parsed) metaData = { ...metaData, ...parsed };
    }
  } catch (err) {
    console.warn("[OnDemandQuiz] generateLessonMeta failed:", err.message);
  }

  // Chuẩn hóa + chạy quiz pipeline
  let data = normalizeLessonData(
    {
      content: context,
      importantNotes: metaData.importantNotes || [],
      summary: metaData.summary || objective,
      quiz: metaData.quiz || [],
    },
    objective, formulaNotes, searchTopic, quizBounds, practiceBias,
    { allowHeuristicFallback: false }
  );

  try {
    data.quiz = await runQuizPipeline({
      existingQuiz: data.quiz,
      context,
      searchTopic,
      objective,
      profile,
      quizBounds,
      formulaNotes,
    });
  } catch (err) {
    console.warn("[OnDemandQuiz] pipeline failed:", err.message);
  }

  // Fallback nếu vẫn thiếu quiz
  if (!data.quiz || data.quiz.length < quizBounds.min) {
    data = normalizeLessonData(
      { ...data },
      objective, formulaNotes, searchTopic, quizBounds, practiceBias,
      { allowHeuristicFallback: true }
    );
  }

  return {
    quiz: data.quiz || [],
    importantNotes: data.importantNotes || [],
    summary: data.summary || objective,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT TITLE FROM TEXT — domain-agnostic fallback
// Tr\u00edch ti\u00eau \u0111\u1ec1 kh\u00f3a h\u1ecdc t\u1eeb n\u1ed9i dung t\u00e0i li\u1ec7u khi AI fail.
// Th\u1eed theo th\u1ee9 t\u1ef1: (1) heading ## \u0111\u1ea7u ti\u00ean, (2) d\u00f2ng ch\u1eef in hoa, (3) c\u00e2u \u0111\u1ea7u ti\u00ean
// ─────────────────────────────────────────────────────────────────────────────
const extractTitleFromText = (text) => {
  if (!text || typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // 1. Markdown heading cấp 1
  for (const line of lines.slice(0, 30)) {
    const h1 = line.match(/^#\s+(.{4,80})/);
    if (h1) return h1[1].replace(/[*_`]/g, '').trim();
  }

  // 2. Markdown heading cấp 2
  for (const line of lines.slice(0, 30)) {
    const h2 = line.match(/^##\s+(.{4,80})/);
    if (h2) return h2[1].replace(/[*_`]/g, '').trim();
  }

  // 3. Dòng ALLCAPS (tiêu đề slide / giáo trình không dùng markdown)
  for (const line of lines.slice(0, 20)) {
    if (line.length >= 5 && line.length <= 80 &&
      line === line.toUpperCase() &&
      /[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐƠƯ]{3,}/.test(line) &&
      !/[{}()[\];=<>]/.test(line)) {
      return line.slice(0, 70);
    }
  }

  // 4. Numbered section đầu tiên "1. Tiêu đề" hoặc "1 Tiêu đề"
  for (const line of lines.slice(0, 20)) {
    const num = line.match(/^(?:1|I)[.)]\s+(.{4,80})/);
    if (num) return num[1].trim().slice(0, 70);
  }

  // 5. Câu đầu tiên có đủ độ dài
  const firstLong = lines.find(l => l.length >= 10 && l.length <= 100 &&
    /[A-Za-zÀ-ỹ]{3,}/.test(l));
  return firstLong ? firstLong.slice(0, 70) : '';
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
  const learningGoals = normalizeLearningGoals(rawLearningGoals);//chuẩn hoá mục tiêu học
  const wordCount = text.split(/\s+/).length;//đếm số từ trong file 

  let requestedDays = parseInt(userDays) || 7;//số ngày học yêu cầu từ người dùng
  const finalDaysMaster = Math.min(DAYS_MAX, Math.max(DAYS_MIN, requestedDays));//số ngày học cuối cùng (tối thiểu 1, tối đa 14)

  const metaContext = fileMetadata
    ? `THONG TIN: So tu: ${fileMetadata.wordCount}. Bang bieu: ${fileMetadata.tableCount > 0 ? fileMetadata.tableCount : "Khong"}. Cong thuc: ${fileMetadata.hasFormulas ? "Co" : "Khong"}. Do phuc tap: ${fileMetadata.estimatedComplexity}.`
    : "";

  const prompt = `Phan tich tai lieu (${wordCount} tu). ${metaContext}

BOI CANH NGUOI HOC:
${analyzeContextBlock(learningGoals)}

QUY TAC:
- suggestedTitle: Ten khoa hoc ngan gon, ro rang (toi da 10 tu)
- summary: 1-2 cau mo ta noi dung chinh, KHONG chung chung

{"suggestedTitle":"...","summary":"..."}`;

  let analysis = {};

  try {
    const response = await makeGroqRequest({
      messages: [
        { role: "system", content: "Chi tra ve JSON hop le. KHONG giai thich, KHONG markdown." },
        { role: "user", content: prompt + "\n\nTEXT:\n" + text.substring(0, MAX_ANALYZE_TEXT) }
      ],
      model: MODEL_FAST,
      temperature: 0.1,
      maxTokens: 300,   // Chỉ cần 2 trường → giảm từ 600 xuống 300
      enforceJSON: true,
    });

    analysis = safeJSONParse(response) || {};

  } catch (err) {
    console.warn("[analyzeDocument] safeJSONParse failed, thử extract thủ công:", err.message);
    // Extract thủ công từ prose nếu AI trả về text thay vì JSON
    try {
      const titleMatch = String(response || "").match(/"suggestedTitle"\s*:\s*"([^"]{3,80})"/);
      const summaryMatch = String(response || "").match(/"summary"\s*:\s*"([^"]{10,300})"/);
      if (titleMatch || summaryMatch) {
        analysis = {
          suggestedTitle: titleMatch?.[1] || "",
          summary: summaryMatch?.[1] || "",
        };
      }
    } catch (_) { }
  }

  // ─────────────────────────────
  // FIX-1: VALIDATION + FALLBACK
  // ─────────────────────────────
  // ⚠️ Đã bỏ normalizeDifficulty + difficulty: UI mới không cần.

  let suggestedTitle = normalizeSpace(analysis.suggestedTitle || "");
  let summary = normalizeSpace(analysis.summary || "");

  // Fix title nếu rỗng / generic
  if (!suggestedTitle || suggestedTitle.length < 5) {
    suggestedTitle = extractTitleFromText(text) || "Lo trinh hoc tu tai lieu";
  }

  // Fix summary nếu generic
  if (
    !summary ||
    summary.length < 20 ||
    /(tong quan|gioi thieu|noi dung tai lieu|overview)/i.test(summary)
  ) {
    summary = `Tai lieu tap trung vao cac noi dung chinh cua "${suggestedTitle}", duoc chia thanh ${finalDaysMaster} ngay hoc theo lo trinh logic.`;
  }

  // Trả về chỉ những trường UI cần (đã bỏ difficulty, suggestedDays)
  const finalAnalysis = {
    suggestedTitle,
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
  generateQuizForLesson,    // ← Hàm on-demand: sinh quiz khi học viên mở bài
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
  verifyLessonContent,      // Export để kiểm thử và gọi từ các scripts kiểm duyệt bài học
  postProcessChunkWithLLM,  // Export để xử lý làm sạch chunk
  checkTextQualityNeedsLLM,  // Export để kiểm tra chất lượng text
};
