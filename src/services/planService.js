// planService.js — COMPLETE OPTIMIZED VERSION (Two-Phase Lesson + Diverse Chunks)
"use strict";

const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks } = require("./vectorSearchService");
const Chunk = require("../models/Chunk");
const { chunkText } = require("../utils/chunkText");
const { cleanText } = require("../utils/cleanText");
const { getLearningMode } = require("./userContextService");
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
// CONSTANTS & MODELS
// ─────────────────────────────────────────────

const MODEL_FAST  = "llama-3.1-8b-instant";
const MODEL_SMART = "llama-3.3-70b-versatile";

const MAX_CONTEXT_CHARS  = 9_500;
const MAX_SYLLABUS_TEXT  = 10_000;
const MAX_ANALYZE_TEXT   = 5_000;
const CHUNK_SEARCH_K     = 10;
const CHUNK_USE_K        = 5;
const DAYS_MIN           = 3;
const DAYS_MAX           = 14;

// FIX: Conservative output token caps cho JSON mode
// llama-3.1-8b-instant bị truncate JSON nếu vượt ~1800 tokens output
const HARD_CAP_FAST  = 1800;
const HARD_CAP_SMART = 2800;

// Bloom's Taxonomy mapping
const BLOOM_LEVELS = [
  { label: "Remember",  vi: "Nhan biet & ghi nho"    },
  { label: "Understand",vi: "Hieu & dien giai"        },
  { label: "Apply",     vi: "Van dung & thuc hanh"   },
  { label: "Analyze",   vi: "Phan tich & so sanh"    },
  { label: "Evaluate",  vi: "Danh gia & tong hop"    },
  { label: "Create",    vi: "Sang tao & mo rong"     },
];

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

/**
 * FIX: Truyền `attempt` vào fn để caller có thể điều chỉnh token budget.
 * Với json_validate_failed: retry nhanh (300ms base).
 * Với rate_limit: retry chậm (1500ms base) + exponential.
 */
const retryWithBackoff = async (fn, maxRetries = 3, onRetry = null) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const msg        = String(err?.message || "");
      const isRateLimit = /rate_limit_exceeded|429/i.test(msg);
      const isJsonError = /json_validate_failed/i.test(msg);

      if (!isRateLimit && !isJsonError) throw err;
      if (attempt === maxRetries - 1) {
        console.warn(`[RetryWithBackoff] Max retries reached: ${err.message}`);
        throw err;
      }

      const baseDelay = isRateLimit ? 1500 : 300;
      const jitter    = Math.random() * 300;
      const delay     = baseDelay * Math.pow(2, attempt) + jitter;

      console.warn(
        `[RetryWithBackoff] Attempt ${attempt + 1}/${maxRetries} ` +
        `(${isRateLimit ? "rate_limit" : "json_error"}), retry in ${Math.round(delay)}ms`
      );
      if (onRetry) onRetry(attempt, err);
      await sleep(delay);
    }
  }
};

// ─────────────────────────────────────────────
// GROQ REQUEST HELPERS
// ─────────────────────────────────────────────

/**
 * FIX: Hard cap giảm xuống HARD_CAP_FAST=1800 cho 8b model.
 * JSON mode cần buffer ~200 tokens cho validator overhead.
 * Mỗi lần retry giảm thêm 200 tokens (tránh truncation gây vỡ JSON).
 */
const makeGroqRequest = async ({
  messages,
  model       = MODEL_FAST,
  temperature = 0.3,
  maxTokens   = 2048,
  enforceJSON = true,
}) => {
  const hardCap       = model.includes("70b") ? HARD_CAP_SMART : HARD_CAP_FAST;
  const jsonBuffer    = enforceJSON ? 200 : 0;
  const baseMax       = Math.min(maxTokens - jsonBuffer, hardCap);

  const requestConfig = {
    messages,
    model,
    temperature,
    max_tokens: Math.max(256, baseMax),
  };
  if (enforceJSON) {
    requestConfig.response_format = { type: "json_object" };
  }

  return await retryWithBackoff(async (attempt) => {
    // Giảm token budget mỗi retry để tránh truncation lặp lại
    requestConfig.max_tokens = Math.max(256, baseMax - attempt * 200);
    const res = await groq.chat.completions.create(requestConfig);
    return res.choices[0].message.content;
  });
};

/**
 * FIX: Plain-text request — KHÔNG dùng JSON mode.
 * Dùng riêng cho Phase 1 (content Markdown).
 * Tránh hoàn toàn json_validate_failed khi content có newlines.
 */
const makeGroqPlainRequest = async ({
  messages,
  model       = MODEL_FAST,
  temperature = 0.1,
  maxTokens   = 1800,
}) => {
  const hardCap = model.includes("70b") ? HARD_CAP_SMART : HARD_CAP_FAST;
  const safeMax = Math.min(maxTokens, hardCap);

  return await retryWithBackoff(async (attempt) => {
    const res = await groq.chat.completions.create({
      messages,
      model,
      temperature,
      max_tokens: Math.max(256, safeMax - attempt * 150),
      // Không có response_format
    });
    return res.choices[0].message.content;
  }, 2); // Chỉ retry 2 lần cho plain text
};

// ─────────────────────────────────────────────
// CORE UTILITIES
// ─────────────────────────────────────────────

const safeJSONParse = (text) => {
  if (!text?.trim()) throw new Error("Empty AI response");

  // Stage 1: Basic cleanup
  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // Stage 2: Extract outermost braces
  const firstBrace = cleaned.indexOf("{");
  const lastBrace  = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  // Stage 3: Direct parse
  try {
    return JSON.parse(cleaned);
  } catch (firstError) {

    // Stage 4: Fix common issues
    try {
      const fixed = cleaned
        .replace(/("\w+"\s*:\s*"[^"]*")\s*\n\s*"/g, '$1,\n"')
        .replace(/("\w+"\s*:\s*\d+)\s*\n\s*"/g,     '$1,\n"')
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
        .replace(/"([^"]*)"([^"]*)"([^"]*)":/g, '"$1\\"$2\\"$3":');
      return JSON.parse(fixed);
    } catch (_) {}

    // Stage 5: Regex extract quiz array
    try {
      const m = cleaned.match(/"quiz"\s*:\s*\[(.*?)\]/s);
      if (m) return JSON.parse(`{"quiz":[${m[1]}]}`);
    } catch (_) {}

    console.error(
      "[safeJSONParse] All recovery attempts failed. First 500 chars:",
      text.substring(0, 500)
    );
    throw new Error(`Invalid JSON after all recovery attempts: ${firstError.message}`);
  }
};

const isJsonValidationError = (err) =>
  /json_validate_failed|max completion tokens reached/i.test(String(err?.message || ""));

const normalizeSpace = (s) => String(s || "").replace(/\s+/g, " ").trim();

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
  normalizeSpace(content).toLowerCase().substring(0, 180);

const splitSentences = (text) =>
  String(text || "")
    .split(/[.!?]\s+/)
    .map(normalizeSpace)
    .filter((s) => s.length > 20);

const extractFormulaLikeNotes = (text) => {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const candidates = [];
  for (const line of lines) {
    const hasMathSymbol     = /[=+\-*/^√∑∏≤≥≈%]/.test(line);
    const hasDefinitionCue  = /(dinh nghia|cong thuc|theorem|lemma|he qua|quy tac|rule|property|axiom)/i.test(line);
    const hasCodeLikeNoise  = /[{}[\];<>]/.test(line) && line.length > 120;

    if ((hasMathSymbol || hasDefinitionCue) && !hasCodeLikeNoise) {
      candidates.push(line.length > 180 ? `${line.slice(0, 180)}...` : line);
    }
  }

  return [...new Set(candidates)].slice(0, 8);
};

const getBloomLevel = (dayIndex, totalDays) => {
  const ratio = dayIndex / Math.max(1, totalDays - 1);
  const idx   = Math.min(BLOOM_LEVELS.length - 1, Math.floor(ratio * BLOOM_LEVELS.length));
  return BLOOM_LEVELS[idx];
};

const getObjectiveSeedsFromText = (text, days) => {
  const sentences = splitSentences(text);
  if (!sentences.length) return Array.from({ length: days }, () => "");
  return Array.from({ length: days }, (_, i) => {
    const idx = Math.floor((i * sentences.length) / Math.max(1, days));
    return (sentences[idx] || sentences[sentences.length - 1] || "").substring(0, 150);
  });
};

// ─────────────────────────────────────────────
// QUIZ VALIDATION PIPELINE
// ─────────────────────────────────────────────

const stripVerdictFromOption = (text) => {
  let s = normalizeSpace(String(text || "").replace(/^\*+|\*+$/g, ""));
  for (let k = 0; k < 4; k++) {
    const n = s
      .replace(VERDICT_PREFIX_RE, "")
      .replace(/^(sai\s+vi|sai\s+phuong\s*an|phuong\s*an\s*sai)\s*[::]\s*/i, "")
      .trim();
    if (n === s) break;
    s = normalizeSpace(n);
  }
  return normalizeSpace(s.replace(/^\*+\s*|\s*\*+$/g, ""));
};

const optionStillHasVerdictLeak = (o) => {
  const t = String(o).trim();
  return /^(dung\s+theo|sai\s*[::])/i.test(t);
};

const countMetaLikeOptions       = (q) => (q.options || []).filter((o) => META_DISTRACTOR_RE.test(String(o))).length;
const countBoilerplateDistractors = (q) => (q.options || []).filter((o) => GENERIC_FALLBACK_DISTRACTOR_RE.test(String(o))).length;

const scoreQuizItem = (q) => {
  if (!q?.question || !Array.isArray(q.options) || q.options.length !== 4) return 0;

  let score = 100;

  if (QUIZ_PLACEHOLDER_RE.test(q.question))             return 0;
  if (countMetaLikeOptions(q) >= 2)                     score -= 40;
  if (countBoilerplateDistractors(q) >= 1)              score -= 35;
  if (q.options.some(optionStillHasVerdictLeak))        score -= 30;
  if (!q.explanation || q.explanation.length < 15)      score -= 15;

  const correct = q.options[q.correctAnswer] || "";
  if (correct.length > 25 && (q.question || "").includes(correct.slice(0, 50))) {
    score -= 20;
  }

  const lengths  = q.options.map((o) => String(o).length);
  const avgLen   = lengths.reduce((a, b) => a + b, 0) / 4;
  const variance = lengths.reduce((a, b) => a + Math.abs(b - avgLen), 0) / 4;
  if (variance < 10) score -= 10;
  if (avgLen   < 15) score -= 15;

  return Math.max(0, score);
};

const normalizeQuizItem = (q) => {
  if (!q?.question || !Array.isArray(q.options)) return null;

  const question     = normalizeSpace(q.question);
  const options      = q.options.map((o) => normalizeSpace(o)).filter(Boolean).slice(0, 4);
  if (options.length !== 4) return null;

  const correctAnswer = Number.isInteger(q.correctAnswer) ? q.correctAnswer : 0;
  if (correctAnswer < 0 || correctAnswer > 3) return null;
  if (QUIZ_PLACEHOLDER_RE.test(question))     return null;

  const stripped = options.map(stripVerdictFromOption).map(normalizeSpace);
  if (stripped.some((o) => !o || o.length < 6 || QUIZ_PLACEHOLDER_RE.test(o))) return null;

  const keys = stripped.map((o) => o.toLowerCase().substring(0, 280));
  if (new Set(keys).size !== 4) return null;

  const normalized = {
    question,
    options: stripped,
    correctAnswer,
    explanation: normalizeSpace(q.explanation || ""),
  };
  normalized._score = scoreQuizItem(normalized);
  return normalized;
};

const dedupeQuizByQuestionStem = (quiz) => {
  const seen = new Set();
  return quiz.filter((q) => {
    const key = normalizeSpace(q.question).toLowerCase().substring(0, 160);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const filterAndRankQuiz = (quiz, threshold = 40) =>
  quiz
    .filter((q) => (q._score ?? scoreQuizItem(q)) >= threshold)
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

const dropQuizzesWithWeakDistractors = (quiz) =>
  quiz.filter(
    (q) =>
      countMetaLikeOptions(q) < 2 &&
      countBoilerplateDistractors(q) < 2 &&
      !(q.options || []).some(optionStillHasVerdictLeak)
  );

const quizItemLooksHeuristicBad = (q) => {
  if (!q || !q.question)                                                            return true;
  if (QUIZ_PLACEHOLDER_RE.test(q.question))                                         return true;
  if ((q.options || []).some((o) => HEURISTIC_QUIZ_BOILERPLATE_RE.test(String(o)))) return true;
  if (countBoilerplateDistractors(q) >= 1)                                          return true;
  return false;
};

const quizBatchLooksLowQuality = (quiz) => {
  if (!Array.isArray(quiz) || quiz.length === 0) return true;
  const avgScore = quiz.reduce((s, q) => s + (q._score ?? scoreQuizItem(q)), 0) / quiz.length;
  return avgScore < 55;
};

const normalizeQuizBatch = (rawQuiz) => {
  const mapped  = (Array.isArray(rawQuiz) ? rawQuiz : []).map(normalizeQuizItem).filter(Boolean);
  const deduped = dedupeQuizByQuestionStem(mapped);
  return filterAndRankQuiz(deduped);
};

// ─────────────────────────────────────────────
// FALLBACK QUIZ (Heuristic, no AI)
// ─────────────────────────────────────────────

const buildFallbackQuiz = (topic, content, importantNotes, count = 3, practiceBias = false) => {
  const seeds     = [...importantNotes, ...splitSentences(content)].filter(Boolean);
  const n         = Math.max(1, Math.min(12, parseInt(count, 10) || 3));
  const topicShort = (normalizeSpace(topic).substring(0, 72) || "chu de").replace(/^["']|["']$/g, "");

  const stemPool = seeds.length
    ? seeds.map((s) => normalizeSpace(s)).filter(Boolean)
    : [
        `Noi dung trong tam ve ${topicShort}`,
        `Y phu tro lien quan ${topicShort}`,
        `Khia canh ung dung ${topicShort}`,
      ];

  const wrongDeclarative = (factNorm, offset) => {
    const others = stemPool.filter((s) => normalizeSpace(s) !== factNorm);
    const base   = others.length >= 3 ? others : stemPool;
    return [
      normalizeSpace(base[(offset + 1) % base.length]).substring(0, 140),
      normalizeSpace(base[(offset + 2) % base.length]).substring(0, 140),
      normalizeSpace(base[(offset + 3) % base.length]).substring(0, 140),
    ];
  };

  const practiceTemplates = [
    (f) => `Voi doan kien thuc "${f.slice(0, 58)}${f.length > 58 ? "..." : ""}", khang dinh nao duoi day la chinh xac nhat?`,
    (f) => `Trong boi canh lien quan "${f.slice(0, 54)}${f.length > 54 ? "..." : ""}", phat bieu nao phu hop voi mo ta trong bai?`,
    (f) => `Cau nao dien dat dung moi quan he / he qua gan voi: "${f.slice(0, 52)}..."?`,
    (f) => `So cac khang dinh sau, cau nao nhat quan voi noi dung "${f.slice(0, 50)}..."?`,
  ];

  const theoryTemplates = [
    (f) => `Khang dinh nao dung nhat doi voi: "${f.slice(0, 82)}${f.length > 82 ? "..." : ""}"?`,
    (f) => `Phat bieu nao phu hop voi cach trinh bay ve "${f.slice(0, 74)}..."?`,
    (f) => `Y nao duoc ho tro truc tiep khi xet "${f.slice(0, 72)}..."?`,
  ];

  return Array.from({ length: n }, (_, i) => {
    const factRaw   = stemPool[i % stemPool.length];
    const fact      = factRaw.substring(0, 140);
    const factNorm  = normalizeSpace(factRaw);
    const templates = practiceBias ? practiceTemplates : theoryTemplates;
    const question  = templates[i % templates.length](fact);
    const correct   = normalizeSpace(fact.length > 125 ? `${fact.slice(0, 122)}...` : fact);
    const [w1, w2, w3] = wrongDeclarative(factNorm, i);
    const options   = [correct, w1, w2, w3].map((o) => normalizeSpace(o));
    const rotate    = i % 4;
    const rotated   = [...options.slice(rotate), ...options.slice(0, rotate)];
    const correctAnswer = rotated.findIndex((x) => x === correct);

    return {
      question: normalizeSpace(question),
      options:  rotated,
      correctAnswer: correctAnswer >= 0 ? correctAnswer : 0,
      explanation: "Phuong an dung tai khang dinh noi dung da hoc; cac phuong an con lai mo ta hieu nham thuong gap.",
      _score: 45,
    };
  });
};

// ─────────────────────────────────────────────
// LESSON DATA NORMALIZATION
// ─────────────────────────────────────────────

const normalizeLessonData = (
  data,
  fallbackObjective   = "",
  fallbackFormulaNotes = [],
  topic               = "",
  quizBounds          = { min: 3, max: 5 },
  practiceBias        = false,
  opts                = {}
) => {
  const allowHeuristicFallback = Boolean(opts.allowHeuristicFallback);
  const minQuiz = Math.max(1, quizBounds.min || 3);
  const maxQuiz = Math.max(minQuiz, quizBounds.max || 5);
  const safe    = data && typeof data === "object" ? data : {};

  const content = typeof safe.content === "string" ? safe.content.trim() : "";
  const summary =
    typeof safe.summary === "string" && safe.summary.trim()
      ? safe.summary.trim()
      : fallbackObjective || "Tom tat noi dung chinh cua bai hoc.";

  const importantNotesRaw    = Array.isArray(safe.importantNotes) ? safe.importantNotes : [];
  const importantNotesMerged = [...importantNotesRaw, ...fallbackFormulaNotes]
    .map((x) => normalizeSpace(x))
    .filter(Boolean);
  const importantNotes = [...new Set(importantNotesMerged)].slice(0, 12);

  let quiz = normalizeQuizBatch(Array.isArray(safe.quiz) ? safe.quiz : []);

  if (allowHeuristicFallback) {
    let padGuard = 0;
    while (quiz.length < minQuiz && padGuard < 3) {
      const need    = minQuiz - quiz.length;
      const autoQuiz = buildFallbackQuiz(
        topic || "bai hoc",
        content || summary,
        importantNotes,
        need + 1,
        practiceBias
      );
      quiz = dedupeQuizByQuestionStem([...quiz, ...autoQuiz]);
      quiz = filterAndRankQuiz(quiz);
      padGuard += 1;
    }
  }

  if (quiz.length > maxQuiz) quiz = quiz.slice(0, maxQuiz);

  return { content, summary, importantNotes, quiz };
};

// ─────────────────────────────────────────────
// RAG: CHUNK SELECTION
// ─────────────────────────────────────────────

/**
 * FIX: Sort by (unused first → relevance score).
 * Thay thế two-pass logic phức tạp bằng sort đơn giản hơn, đúng hơn.
 */
const selectDiverseChunks = (chunks, usedSignatures, topK = CHUNK_USE_K) => {
  const usedSet = new Set((usedSignatures || []).map(String));

  const scored = chunks.map((chunk) => {
    const sig      = getChunkSignature(chunk.content);
    const prefix   = sig.substring(0, 80);
    const penalized = usedSet.has(sig);
    return { chunk, sig, prefix, penalized, score: chunk.score ?? 0 };
  });

  // Unused chunks first, then by relevance score descending
  scored.sort((a, b) => {
    if (a.penalized !== b.penalized) return a.penalized ? 1 : -1;
    return b.score - a.score;
  });

  const sigPrefixSeen = new Set();
  const selected      = [];

  for (const { chunk, prefix } of scored) {
    if (selected.length >= topK) break;
    if (!sigPrefixSeen.has(prefix)) {
      selected.push(chunk);
      sigPrefixSeen.add(prefix);
    }
  }

  return selected;
};

// ─────────────────────────────────────────────
// HyDE
// ─────────────────────────────────────────────

const generateHyDE = async (topic, objective) => {
  try {
    const response = await makeGroqPlainRequest({
      messages: [
        {
          role: "user",
          content: `Viet 3-4 cau mo ta kien thuc chi tiet cua chu de: "${topic}". Muc tieu: ${objective || topic}. Chi tra ve doan van, khong giai thich.`,
        },
      ],
      model:       MODEL_FAST,
      temperature: 0.3,
      maxTokens:   180,
    });
    return response || topic;
  } catch {
    return `Kien thuc chi tiet ve chu de "${topic}": ${objective}`;
  }
};

// ─────────────────────────────────────────────
// QUIZ PROMPT BUILDERS
// ─────────────────────────────────────────────

const buildConciseQuizPrompt = ({ context, searchTopic, objective, count, avoidQuestions = [], formulaNotes = [] }) => {
  const avoidBlock   = avoidQuestions.slice(0, 8).map((q, i) => `${i + 1}. ${String(q).slice(0, 100)}`).join("\n");
  const formulaHint  = formulaNotes.length > 0
    ? `\nCONG THUC: ${formulaNotes.slice(0, 4).join("; ")}`
    : "";

  return `Tao dung ${count} cau trac nghiem 4 phuong an de cung co kien thuc tu CONTEXT.

TOPIC: ${searchTopic}
MUC TIEU: ${objective}${formulaHint}

QUY TAC BAT BUOC:
- Moi cau hoi test 1 y cu the (dinh nghia/quy trinh/cong thuc)
- 4 phuong an cung do dai, khong ghi "Dung:", "Sai:"
- Phuong an sai phai "co the tin duoc" voi nguoi chua hoc
- Khong lap cung mau cau cho nhieu distractor
- Bat buoc tra JSON dung format

TRANH TRUNG:
${avoidBlock || "Khong co"}

CONTEXT (bat buoc bam sat):
${String(context).substring(0, 5500)}

JSON FORMAT:
{
  "quiz": [
    {
      "question": "Cau hoi ngan gon?",
      "options": ["A","B","C","D"],
      "correctAnswer": 0,
      "explanation": "Giai thich ngan"
    }
  ]
}`;
};

const buildMinimalQuizPrompt = ({ context, searchTopic, count }) =>
  `Tu doan text, tao ${count} cau hoi trac nghiem 4 phuong an ve "${searchTopic}".

TEXT:
${String(context).substring(0, 2500)}

Chi tra ve JSON hop le:
{"quiz":[{"question":"...?","options":["A","B","C","D"],"correctAnswer":0,"explanation":"..."}]}`;

// ─────────────────────────────────────────────
// AI QUIZ GENERATION
// ─────────────────────────────────────────────

const generateQuizOnlyGroq = async ({
  context,
  searchTopic,
  objective,
  profile,
  count,
  avoidQuestions   = [],
  formulaNotes     = [],
  useSmarterModel  = false,
}) => {
  const c        = Math.max(1, Math.min(8, parseInt(count, 10) || 4));
  const model    = useSmarterModel ? MODEL_SMART : MODEL_FAST;
  const maxTokens = useSmarterModel ? 2800 : 1600;

  // Stage 1: Concise prompt
  try {
    const response = await makeGroqRequest({
      messages: [
        { role: "system", content: "Tra ve JSON chinh xac voi khoa 'quiz'. Khong them text nao khac." },
        { role: "user",   content: buildConciseQuizPrompt({ context, searchTopic, objective, count: c, avoidQuestions, formulaNotes }) },
      ],
      model,
      temperature: 0.25,
      maxTokens,
      enforceJSON: true,
    });
    const parsed = safeJSONParse(response);
    if (Array.isArray(parsed.quiz) && parsed.quiz.length > 0) return parsed.quiz;
  } catch (err) {
    console.warn(`[Quiz Stage1] ${model} failed:`, err.message);
  }

  // Stage 2: Minimal prompt fallback
  try {
    const response = await makeGroqRequest({
      messages: [{ role: "user", content: buildMinimalQuizPrompt({ context, searchTopic, count: Math.min(c, 3) }) }],
      model:    MODEL_FAST,
      temperature: 0.15,
      maxTokens:   1400,
      enforceJSON: true,
    });
    const parsed = safeJSONParse(response);
    if (Array.isArray(parsed.quiz)) return parsed.quiz;
  } catch (err) {
    console.warn(`[Quiz Stage2] Minimal prompt failed:`, err.message);
  }

  console.warn(`[Quiz Pipeline] All AI attempts failed for topic: ${searchTopic}`);
  return [];
};

/**
 * 3-Tier quiz pipeline.
 */
const runQuizPipeline = async ({
  existingQuiz,
  context,
  searchTopic,
  objective,
  profile,
  quizBounds,
  formulaNotes,
}) => {
  let quiz     = [...existingQuiz];
  const goodQuiz = () => filterAndRankQuiz(quiz);
  const needMore = () => {
    const g = goodQuiz();
    return g.length < quizBounds.min || quizBatchLooksLowQuality(g);
  };

  if (!needMore()) return goodQuiz().slice(0, quizBounds.max);

  // Tier 1: Fast model
  try {
    const fresh = await generateQuizOnlyGroq({
      context, searchTopic, objective, profile,
      count:          quizBounds.max,
      avoidQuestions: quiz.map((q) => q.question),
      formulaNotes,
      useSmarterModel: false,
    });
    quiz = [...quiz, ...fresh];
  } catch (e) {
    console.warn("[QuizPipeline] Tier1 failed:", e.message);
  }

  if (!needMore()) return goodQuiz().slice(0, quizBounds.max);

  // Tier 2: Smarter model
  try {
    const fresh2 = await generateQuizOnlyGroq({
      context, searchTopic, objective, profile,
      count:          quizBounds.max,
      avoidQuestions: goodQuiz().map((q) => q.question),
      formulaNotes,
      useSmarterModel: true,
    });
    quiz = [...quiz, ...fresh2];
  } catch (e) {
    console.warn("[QuizPipeline] Tier2 failed:", e.message);
  }

  return goodQuiz().slice(0, quizBounds.max);
};

// ─────────────────────────────────────────────
// TWO-PHASE LESSON HELPERS
// ─────────────────────────────────────────────

/**
 * FIX CHINH: Phase 1 — sinh content Markdown bằng plain-text request.
 * Hoan toan tranh json_validate_failed vi KHONG dung JSON mode.
 */
const generateLessonContent = async ({
  searchTopic,
  bloomLevel,
  bloomInstruction,
  objective,
  selectedPersona,
  profile,
  context,
  previousBlock,
  dayNumber,
}) => {
  const contentPrompt = `Ban la AI soan bai giang theo Bloom's Taxonomy. Viet noi dung bai hoc dang Markdown.

BAI HOC: Ngay ${dayNumber} - "${searchTopic}"
CAP DO BLOOM: ${bloomLevel} -> ${bloomInstruction}
MUC TIEU: ${objective || "Bam sat noi dung cot loi."}
NGUOI HOC: ${selectedPersona}
LOD TRINH: ${lessonStyleInstructions(profile)}

CONTEXT TAI LIEU:
${String(context).substring(0, 5000)}

NHUNG NGAY TRUOC DA DAY (TUYET DOI KHONG LAP LAI):
${previousBlock}

YEU CAU:
- Chi viet noi dung Markdown (heading, bullet, vi du)
- KHONG viet quiz, KHONG viet JSON
- 250-400 tu
- Chi dung thong tin tu CONTEXT, khong bia
- Khong lap noi dung da day cac ngay truoc`;

  try {
    let content = await makeGroqPlainRequest({
      messages: [
        { role: "system", content: "Ban chi viet noi dung bai giang Markdown. Khong xuat JSON. Khong viet quiz." },
        { role: "user",   content: contentPrompt },
      ],
      model:       MODEL_FAST,
      temperature: profile.focus === "practice" ? 0.2 : 0.1,
      maxTokens:   1800,
    });

    // Strip markdown code fence neu model wrap
    content = content
      .replace(/^```(?:markdown|md)?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();

    // Strip quiz sections accidentally appended
    for (const marker of ["### Quiz", "### Trac nghiem", "## Quiz", "---\n**Quiz"]) {
      const idx = content.indexOf(marker);
      if (idx !== -1) content = content.slice(0, idx).trim();
    }

    return content;
  } catch (err) {
    console.warn("[Phase1] Content generation failed:", err.message);
    return `## ${searchTopic}\n\nNoi dung dang duoc cap nhat tu tai lieu goc.`;
  }
};

/**
 * Phase 2 — sinh importantNotes + summary + quiz bang JSON mode.
 * Request nay nho gon (~1600 tokens) nen it bi truncate hon.
 */
const generateLessonMeta = async ({
  context,
  searchTopic,
  objective,
  bloomLevel,
  quizBounds,
  profile,
  formulaNotes,
}) => {
  const quizCount = quizBounds.max;
  const prompt = `Dua vao CONTEXT, tao JSON metadata cho bai hoc "${searchTopic}".

CONTEXT:
${String(context).substring(0, 4000)}

Tao dung ${quizCount} cau quiz + importantNotes + summary (1-2 cau).
Bloom level: ${bloomLevel}.
Muc tieu: ${objective}

BAT BUOC - Phuong an quiz:
- Chi la khang dinh trung tinh, KHONG co "Dung theo bai:", "Sai:"
- Moi phuong an la 1 cau hoan chinh, do dai tuong duong nhau
- correctAnswer la index 0-3

Cong thuc / dinh nghia tu CONTEXT: ${formulaNotes.slice(0, 4).join("; ") || "Khong co"}

{"importantNotes":["..."],"summary":"...","quiz":[{"question":"...","options":["A","B","C","D"],"correctAnswer":0,"explanation":"..."}]}`;

  return await makeGroqRequest({
    messages: [
      { role: "system", content: "Chi xuat JSON hop le. Khong them bat ky text nao khac." },
      { role: "user",   content: prompt },
    ],
    model:       MODEL_FAST,
    temperature: 0.15,
    maxTokens:   1600,
    enforceJSON: true,
  });
};

// ─────────────────────────────────────────────
// 1. SYLLABUS GENERATION
// ─────────────────────────────────────────────

const buildFallbackPreviewPlan = (text, days) => {
  const clean  = normalizeSpace(text).substring(0, 1200);
  const parts  = clean.split(/[.!?]\s+/).filter(Boolean);
  return Array.from({ length: days }, (_, i) => {
    const snippet = parts[i] || parts[parts.length - 1] || "Noi dung cot loi tu tai lieu";
    const bloom   = getBloomLevel(i, days);
    return {
      dayNumber:  i + 1,
      objective:  snippet.substring(0, 120),
      bloomLevel: bloom.label,
    };
  });
};

const generateSyllabus = async (rawText, numDays, learningGoalsInput = null) => {
  const learningGoals  = normalizeLearningGoals(learningGoalsInput || {});
  const objectiveSeeds = getObjectiveSeedsFromText(rawText, numDays);

  const bloomHints = Array.from({ length: numDays }, (_, i) => {
    const bloom = getBloomLevel(i, numDays);
    return `Ngay ${i + 1} -> Cap do Bloom: ${bloom.vi} (${bloom.label})`;
  }).join("\n");

  const syllabusPrompt = `Ban la chuyen gia thiet ke chuong trinh hoc dua tren Bloom's Taxonomy.

NHIEM VU:
Chia tai lieu thanh ${numDays} ngay hoc.

MUC TIEU NGUOI HOC (ap dung khi dat title/objective tung ngay):
${syllabusBiasInstructions(learningGoals)}

TIEN TRINH NHAN THUC BAT BUOC (Bloom's Taxonomy):
${bloomHints}

QUY TAC BAT BUOC:

1. KHONG TRUNG NOI DUNG
- Moi ngay phai day mot phan kien thuc KHAC nhau
- Khong lap lai khai niem giua cac ngay
- Khong chia cung 1 noi dung thanh nhieu ngay

2. TIEN TRINH LOGIC
- Ngay dau: nen tang (Remember/Understand)
- Ngay giua: kien thuc chinh (Apply/Analyze)
- Ngay cuoi: nang cao / tong hop (Evaluate/Create)

3. TIEU DE
- <= 5 tu
- Khong chua ten khoa hoc
- Khong chua tien to (Day 1, Bai 1)

4. OBJECTIVE
- 1 cau duy nhat
- Mo ta chinh xac noi dung tu tai lieu
- Khop cap do Bloom cua ngay do

5. CAM:
- Bia noi dung
- Viet tieu de chung chung

OUTPUT JSON:
{
  "title": "Ten khoa hoc",
  "syllabus": [
    {
      "dayNumber": 1,
      "title": "...",
      "objective": "...",
      "bloomLevel": "Remember"
    }
  ]
}`;

  const response = await makeGroqRequest({
    messages: [
      {
        role:    "user",
        content: syllabusPrompt + "\n\nTEXT:\n" + rawText.substring(0, MAX_SYLLABUS_TEXT),
      },
    ],
    model:       MODEL_FAST,
    temperature: 0.1,
    maxTokens:   2800,
    enforceJSON: true,
  });

  const data        = safeJSONParse(response);
  const usedTitles  = new Set();

  const syllabus = (data.syllabus || []).map((item, i) => {
    let title     = item.title || "";
    let baseNorm  = normalizeTitle(title);
    let objective = normalizeSpace(item.objective || "");
    const bloom   = getBloomLevel(i, numDays);

    const genericObjective =
      !objective ||
      objective.length < 20 ||
      /(tong quan|gioi thieu|nam duoc|hieu ve|overview|introduction)/i.test(objective);
    if (genericObjective) {
      objective = objectiveSeeds[i] || `Nam vung noi dung ${bloom.vi} cua chuyen de ${i + 1} tu tai lieu goc.`;
    }

    let suffixIndex = 2;
    while (baseNorm && usedTitles.has(baseNorm)) {
      title    = `${item.title || ""} (${suffixIndex})`;
      baseNorm = normalizeTitle(title);
      suffixIndex += 1;
    }
    if (baseNorm) usedTitles.add(baseNorm);

    return {
      dayNumber:  item.dayNumber || i + 1,
      title,
      objective,
      bloomLevel: item.bloomLevel || bloom.label,
    };
  });

  return { title: data.title, syllabus };
};

// ─────────────────────────────────────────────
// 2. CHUNK + EMBEDDING PROCESSING
// ─────────────────────────────────────────────

const processAndStoreDocument = async (planId, text) => {
  const cleaned = cleanText(text);
  const chunks  = chunkText(cleaned);

  const docs                = [];
  const requestedConcurrency = Number(process.env.EMBEDDING_CONCURRENCY || 2);
  const concurrency         = Math.max(2, Math.min(3, requestedConcurrency));
  let cursor                = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = cursor++;
      if (currentIndex >= chunks.length) break;

      const c = chunks[currentIndex];
      try {
        if (currentIndex > 0) await sleep(100);

        const embedding = await retryWithBackoff(async () =>
          generateEmbedding(c.content, "passage")
        );

        if (!embedding || embedding.length === 0) {
          console.warn("Bo qua chunk do embedding bi null");
          continue;
        }

        docs.push({
          planId,
          content:    c.content,
          embedding,
          chunkIndex: c.index,
          metadata:   { wordCount: c.wordCount },
        });
      } catch (err) {
        console.error("Loi tai chunk:", c.index, err.message);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker())
  );

  if (docs.length > 0) {
    docs.sort((a, b) => a.chunkIndex - b.chunkIndex);
    await Chunk.insertMany(docs);
    console.log(`Da luu ${docs.length} chunks voi Vector 1024-dim.`);
  }
};

// ─────────────────────────────────────────────
// 3. LESSON GENERATION (RAG + TWO-PHASE + BLOOM)
// ─────────────────────────────────────────────

const generateScientificLesson = async (
  planId,
  item,
  userId             = null,
  previousTopics     = [],
  usedChunkSignatures = [],
  learningProfile    = null
) => {
  try {
    const profile      = normalizeLearningGoals(learningProfile || {});
    const quizBounds   = getQuizBounds(profile);
    const practiceBias = profile.focus === "practice";
    const topic        = item.topic;
    const objective    = item.objective || "";
    const bloomLevel   = item.bloomLevel || getBloomLevel(item.day - 1, 7).label;

    const mode      = userId ? await getLearningMode(userId, topic) : "NORMAL";
    const personaMap = {
      REMEDIAL: "Giai thich don gian, nhieu vi du doi thuong, tranh thuat ngu kho.",
      NORMAL:   "Giang day chuan dai hoc: logic, ro rang, co vi du thuc te.",
      ADVANCED: "Phan tich chuyen sau, ky thuat, toi uu, neu nuance va edge case.",
    };
    const selectedPersona = personaMap[mode] || personaMap.NORMAL;

    const bloomDepthMap = {
      Remember:  "Tap trung dinh nghia, liet ke, ghi nho khai niem co ban.",
      Understand:"Giai thich y nghia, dien dat lai bang tu rieng, so sanh voi khai niem lien quan.",
      Apply:     "Ap dung cong thuc/quy trinh vao vi du cu the, bai tap tinh toan.",
      Analyze:   "Phan tich cau truc, tim moi quan he nhan-qua, so sanh va phan biet.",
      Evaluate:  "Danh gia uu/nhuoc diem, chon giai phap tot hon, lap luan co can cu.",
      Create:    "Tong hop kien thuc, de xuat mo hinh/giai phap moi, lien he thuc te.",
    };
    const bloomInstruction = bloomDepthMap[bloomLevel] || "Nam vung noi dung cot loi cua bai hoc nay.";

    const searchTopic = topic.includes(" - ") ? topic.split(" - ").pop() : topic;

    // ── RAG ──
    const hydePassage       = await generateHyDE(searchTopic, objective);
    const queryVector       = await generateEmbedding(`passage: ${hydePassage}`, "query");
    const contextChunks     = await searchRelevantChunks(planId, queryVector, CHUNK_SEARCH_K);
    const selectedChunks    = selectDiverseChunks(contextChunks, usedChunkSignatures, CHUNK_USE_K);
    const currentChunkSigs  = selectedChunks.map((c) => getChunkSignature(c.content));
    const context           = selectedChunks.length
      ? selectedChunks.map((c) => c.content).join("\n---\n")
      : "Khong co context.";
    const formulaNotesFromContext = extractFormulaLikeNotes(context);
    const previousBlock = previousTopics.length > 0
      ? previousTopics.join(", ")
      : "Chua co bai nao truoc do.";

    // ── PHASE 1: Content (plain text, NO JSON mode) ──
    const lessonContent = await generateLessonContent({
      searchTopic,
      bloomLevel,
      bloomInstruction,
      objective,
      selectedPersona,
      profile,
      context,
      previousBlock,
      dayNumber: item.day,
    });

    // ── PHASE 2: Meta (JSON mode, compact) ──
    let metaData = { importantNotes: [], summary: "", quiz: [] };
    try {
      const metaRaw = await generateLessonMeta({
        context,
        searchTopic,
        objective,
        bloomLevel,
        quizBounds,
        profile,
        formulaNotes: formulaNotesFromContext,
      });
      metaData = safeJSONParse(metaRaw);
    } catch (metaErr) {
      console.warn("[Phase2] Meta JSON failed:", metaErr.message);
      // Giu default, quiz pipeline se fill
    }

    // ── Gop lai ──
    let data = {
      content:        lessonContent,
      importantNotes: metaData.importantNotes || [],
      summary:        metaData.summary || objective || `Bai hoc ve ${searchTopic}`,
      quiz:           metaData.quiz    || [],
    };

    // Normalize
    data = normalizeLessonData(
      data, objective, formulaNotesFromContext,
      searchTopic, quizBounds, practiceBias,
      { allowHeuristicFallback: false }
    );

    // 3-Tier quiz pipeline
    data.quiz = await runQuizPipeline({
      existingQuiz: data.quiz,
      context,
      searchTopic,
      objective,
      profile,
      quizBounds,
      formulaNotes: formulaNotesFromContext,
    });

    // Last resort heuristic
    if (data.quiz.length < quizBounds.min) {
      data = normalizeLessonData(
        { ...data }, objective, formulaNotesFromContext,
        searchTopic, quizBounds, practiceBias,
        { allowHeuristicFallback: true }
      );
    }

    data.usedChunkSignatures = currentChunkSigs;
    return data;
  } catch (err) {
    console.error("[generateScientificLesson] Error:", err.message);
    return {
      content:             "Noi dung dang duoc cap nhat...",
      importantNotes:      [],
      summary:             "Loi AI",
      quiz:                [],
      usedChunkSignatures: [],
    };
  }
};

// ─────────────────────────────────────────────
// 4. ANALYZE DOCUMENT
// ─────────────────────────────────────────────

const analyzeDocument = async (text, rawLearningGoals = {}, fileMetadata = null) => {
  const learningGoals = normalizeLearningGoals(rawLearningGoals);
  const wordCount     = text.split(/\s+/).length;

  // Add metadata context to prompt
  const metaContext = fileMetadata ? `
THÔNG TIN TÀI LIỆU:
- Số từ: ${fileMetadata.wordCount}
- Có bảng biểu: ${fileMetadata.tableCount > 0 ? "Có (" + fileMetadata.tableCount + " dòng bảng)" : "Không"}
- Có công thức toán: ${fileMetadata.hasFormulas ? "Có" : "Không"}  
- Độ phức tạp ước tính: ${fileMetadata.estimatedComplexity}
` : "";
 
  const prompt = `Phân tích tài liệu (${wordCount} từ).
NHIỆM VỤ: Đề xuất thông số khoa học.
${metaContext}
BỐI CẢNH NGƯỜI HỌC (ảnh hưởng tới suggestedDays, difficulty và cách chia chương trình):
${analyzeContextBlock(learningGoals)}
 
QUY TẮC BẮT BUỘC:
- suggestedDays: Phải là MỘT SỐ NGUYÊN DUY NHẤT trong khoảng [${DAYS_MIN}, ${DAYS_MAX}].
- KHÔNG trả về dạng khoảng như "5-7" hay "3-4". Hãy chọn con số hợp lý nhất.
- difficulty: "Easy" | "Medium" | "Hard".
- Nếu tài liệu có nhiều bảng biểu/số liệu → ưu tiên dạy các bài về đọc hiểu và phân tích dữ liệu.
 
Trả JSON:
{
  "suggestedTitle": "...",
  "difficulty": "Easy|Medium|Hard", 
  "suggestedDays": 7,
  "summary": "..."
}`;

  let analysis = {};
  try {
    const response = await makeGroqRequest({
      messages: [
        { role: "user", content: prompt + "\n\nTEXT:\n" + text.substring(0, MAX_ANALYZE_TEXT) },
      ],
      model:       MODEL_FAST,
      temperature: 0.1,
      maxTokens:   600,
      enforceJSON: true,
    });
    analysis = safeJSONParse(response);
  } catch (err) {
    console.warn("analyzeDocument fallback:", err.message);
    const baseDays   = wordCount > 2500 ? 10 : wordCount > 1200 ? 7 : 5;
    const bumpDeep   = learningGoals.depth === "deep"  ?  2 : 0;
    const shrinkBasic = learningGoals.depth === "basic" ? -1 : 0;
    let fbDays = Math.max(DAYS_MIN, Math.min(DAYS_MAX, baseDays + bumpDeep + shrinkBasic));
    analysis = {
      suggestedTitle: "Khoa hoc tu tai lieu tai len",
      difficulty:     wordCount > 2500 ? "Hard" : wordCount > 1200 ? "Medium" : "Easy",
      suggestedDays:  fbDays,
      summary:        "He thong tam dung che do du phong do AI qua tai.",
    };
  }

  let finalDays = parseInt(analysis.suggestedDays);
  if (isNaN(finalDays)) finalDays = 7;
  finalDays = Math.max(DAYS_MIN, Math.min(DAYS_MAX, finalDays));

  let preview;
  try {
    preview = await generateSyllabus(text, finalDays, learningGoals);
  } catch (err) {
    console.warn("generateSyllabus fallback:", err.message);
    preview = { syllabus: buildFallbackPreviewPlan(text, finalDays) };
  }

  return {
    analysis: {
      ...analysis,
      suggestedDays: finalDays,
      learningGoals,
    },
    previewPlan: preview.syllabus,
  };
};

// ─────────────────────────────────────────────
// MODULE EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  generateSyllabus,
  processAndStoreDocument,
  generateScientificLesson,
  analyzeDocument,

  // Utilities (testing / debugging)
  safeJSONParse,
  retryWithBackoff,
  makeGroqRequest,
  makeGroqPlainRequest,
  normalizeQuizBatch,
  scoreQuizItem,
  buildFallbackQuiz,
  extractFormulaLikeNotes,
  getBloomLevel,
  selectDiverseChunks,
  generateHyDE,
};
