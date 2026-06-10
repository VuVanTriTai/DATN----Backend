"use strict";

// ─────────────────────────────────────────────────────────────────
// utils/aiChunkText.js — LLM-POWERED SEMANTIC CHUNKER (multi-topic edition)
//
// When to use instead of chunkText.js:
//   - Document has no Markdown headings (e.g. raw OCR, contract text)
//   - You need section titles inferred from content, not just headings
//   - Precision > speed is required
//   - Multi-topic documents where topics need to be detected automatically
//
// Flow:
//   1. Pre-chunk text into windows (to stay inside context limit)
//   2. For each window, ask LLM to produce JSON chunk array
//   3. Repair JSON if model adds prose/markdown around it
//   4. Merge, re-index, deduplicate boundary overlap
//   5. Fallback to rule-based chunkText on any hard failure
//
// FIXES + IMPROVEMENTS so với version cũ:
//   #1 — dedupBoundary: dùng SHA-256 hash toàn bộ content thay vì
//        60 ký tự đầu+cuối, tránh false positive với chunk có cùng heading.
//   #2 — buildWindows: không overlap lúc pos = 0.
//   #3 — chunkWindow: retry 1 lần khi JSON parse fail trước khi fallback.
//   #4 — normalizeChunk: chuẩn hoá section (bỏ leading #, trim).
//   #5 — aiChunkText: log rõ số chunk bị drop để dễ debug.
//   #6 — FIX BUG: buildWindows thêm safety guard tránh infinite loop
//        khi advance <= 0.
//   #7 — MULTI-TOPIC: prompt yêu cầu LLM detect topic + subtopic.
//        Output thêm field "topic" để downstream classifier có hint.
//   #8 — MULTI-TOPIC: normalizeChunk thêm field topic từ LLM output.
//   #9 — MULTI-TOPIC: dedupBoundary chỉ dedup khi cùng topic + cùng content,
//        tránh xóa nhầm chunk có nội dung giống nhau ở chủ đề khác nhau
//        (ví dụ: "Introduction" xuất hiện ở nhiều chapter).
// ─────────────────────────────────────────────────────────────────

const Groq   = require("groq-sdk");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const { chunkText } = require("./chunkText");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const DEBUG_PATH = path.join(__dirname, "../debug/debug_ai_chunks.json");

// ─── tunables ────────────────────────────────
const MODEL          = "llama-3.1-8b-instant";
const TEMPERATURE    = 0.1;
const WINDOW_CHARS   = 8000;
const WINDOW_OVERLAP = 400;
const MIN_WORDS      = 30;
const MAX_RETRY      = 1;
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Extract the first JSON array from an arbitrary string.
 * Handles bare JSON, ```json fences, and prose surrounding the array.
 */
const extractJsonArray = (raw) => {
  try { return JSON.parse(raw); } catch {}

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  const start = raw.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "[") depth++;
    else if (raw[i] === "]") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch {}
      }
    }
  }
  return null;
};

/**
 * Split text into overlapping windows so each fits in the LLM context.
 * Splits at paragraph boundaries when possible.
 *
 * FIX #2: lần đầu (pos = 0) không áp dụng overlap backward.
 * FIX #6: safety guard tránh infinite loop khi advance <= 0.
 */
const buildWindows = (text) => {
  if (text.length <= WINDOW_CHARS) return [text];

  const windows = [];
  let pos = 0;

  while (pos < text.length) {
    const end = pos + WINDOW_CHARS;

    if (end >= text.length) {
      windows.push(text.slice(pos));
      break;
    }

    const slice     = text.slice(pos, end);
    const lastBreak = slice.lastIndexOf("\n\n");
    const breakAt   = lastBreak > WINDOW_CHARS * 0.5
      ? lastBreak + 2
      : slice.length;

    windows.push(text.slice(pos, pos + breakAt));

    // FIX #2: chỉ áp dụng overlap từ window thứ 2 trở đi
    const advance = windows.length === 1
      ? breakAt
      : Math.max(breakAt - WINDOW_OVERLAP, 1);

    // FIX #6: safety guard — không bao giờ để vòng lặp đứng im
    if (advance <= 0) {
      console.error("[buildWindows] advance <= 0, force-advancing to prevent infinite loop");
      pos += Math.max(breakAt, WINDOW_CHARS);
      continue;
    }

    pos += advance;
  }

  return windows;
};

/**
 * Build the prompt for a single window.
 *
 * FIX #7: MULTI-TOPIC — yêu cầu LLM detect topic cho từng chunk.
 * topic giúp downstream TopicClassifier có prior hint,
 * giảm misclassification với tài liệu đa chủ đề.
 */
const buildPrompt = (windowText, windowIndex, totalWindows) => `
You are a document chunking engine for a multi-topic e-learning platform.
Your ONLY output is a valid JSON array — no prose, no markdown, no explanation.

TASK: Split the document excerpt into semantic chunks.

RULES:
1. Each chunk = one self-contained idea, concept, or procedure.
2. NEVER cut mid-sentence, mid-table, mid-code block, or mid-list.
3. Keep tables INTACT inside a single chunk.
4. Keep code examples with the concept they illustrate.
5. Detect a concise section title from context; use "" if none.
6. Each chunk must have >= ${MIN_WORDS} words.
7. Detect the topic/subject area for each chunk (e.g. "math", "history",
   "programming", "biology", "economics", "language", "general", etc.).
   Use the most specific label that fits. For sub-topics, use format:
   "parent_topic/subtopic" (e.g. "programming/algorithms", "math/calculus").
8. Do NOT add any text outside the JSON array.

OUTPUT FORMAT (strict — no keys other than these three):
[
  {
    "section": "<title or empty string>",
    "topic"  : "<detected topic label>",
    "content": "<full chunk text>"
  },
  ...
]

${totalWindows > 1 ? `[Window ${windowIndex + 1} of ${totalWindows}]` : ""}

DOCUMENT:
${windowText}
`;

// ─────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────

/**
 * Call the LLM for one text window.
 *
 * FIX #3: retry MAX_RETRY lần khi JSON parse fail trước khi fallback.
 */
const chunkWindow = async (windowText, windowIndex, totalWindows) => {
  const messages = [
    {
      role   : "system",
      content: "You are a document chunking engine for a multi-topic platform. Output ONLY a valid JSON array. No prose, no markdown fences, no explanation.",
    },
    {
      role   : "user",
      content: buildPrompt(windowText, windowIndex, totalWindows),
    },
  ];

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const res = await groq.chat.completions.create({
      model      : MODEL,
      temperature: TEMPERATURE,
      messages,
    });

    const raw    = res.choices?.[0]?.message?.content || "";
    const parsed = extractJsonArray(raw);

    if (parsed && Array.isArray(parsed)) return parsed;

    if (attempt < MAX_RETRY) {
      console.warn(
        `⚠️  Window ${windowIndex} attempt ${attempt + 1}: JSON parse failed, retrying…`
      );
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role   : "user",
        content: "Your previous response was not valid JSON. Output ONLY the JSON array, starting with [ and ending with ].",
      });
    }
  }

  console.warn(
    `⚠️  Window ${windowIndex}: JSON parse failed after ${MAX_RETRY + 1} attempts, using rule-based fallback`
  );
  return null;
};

/**
 * Normalize a raw chunk object from the LLM.
 *
 * FIX #4: chuẩn hoá section (bỏ leading #, trim).
 * FIX #8: MULTI-TOPIC — lưu topic từ LLM output vào chunk.
 */
const normalizeChunk = (raw, index) => {
  const content   = (raw.content || "").trim();
  const section   = (raw.section || "").trim().replace(/^#+\s*/, ""); // FIX #4
  const topic     = (raw.topic   || "general").trim().toLowerCase();  // FIX #8
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return { index, section, topic, content, wordCount };
};

// ─────────────────────────────────────────────
// DEDUP
// ─────────────────────────────────────────────

/**
 * FIX #1 + #9:
 *
 * #1: SHA-256 hash của content làm fingerprint.
 * #9: MULTI-TOPIC — fingerprint = hash(topic + content).
 *     Hai chunk cùng content nhưng khác topic KHÔNG bị dedup.
 *     Ví dụ: "Introduction" ở Chapter 1 (math) và Chapter 2 (history)
 *     là 2 chunk khác nhau, không nên bị xóa.
 */
const contentHash = (content, topic = "") =>
  crypto
    .createHash("sha256")
    .update(`${topic}::${content}`)
    .digest("hex")
    .slice(0, 16);

const dedupBoundary = (chunks) => {
  const seen = new Set();
  return chunks.filter(chunk => {
    const fp = contentHash(chunk.content, chunk.topic || ""); // FIX #9
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
};

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

const aiChunkText = async (text) => {
  if (!text || text.length < 50) return [];

  try {
    const windows = buildWindows(text);
    console.log(
      `🧠 aiChunkText: ${windows.length} window(s) for ${text.length} chars`
    );

    const allRaw        = [];
    let anyWindowFailed = false;

    for (let i = 0; i < windows.length; i++) {
      const result = await chunkWindow(windows[i], i, windows.length);
      if (result === null) {
        anyWindowFailed = true;
        const fallback  = chunkText(windows[i]);
        for (const fb of fallback) {
          // Fallback chunks không có LLM-detected topic → default "general"
          allRaw.push({
            section: fb.section || "",
            topic  : "general",
            content: fb.content,
          });
        }
      } else {
        allRaw.push(...result);
      }
    }

    // FIX #5: đếm và log chunk bị drop do MIN_WORDS
    const beforeFilter = allRaw.length;
    const filtered     = allRaw.filter(
      c => (c.content || "").split(/\s+/).filter(Boolean).length >= MIN_WORDS
    );
    const droppedCount = beforeFilter - filtered.length;
    if (droppedCount > 0) {
      console.warn(
        `⚠️  aiChunkText: dropped ${droppedCount} chunks < ${MIN_WORDS} words. ` +
        `Kiểm tra lại MIN_WORDS hoặc tài liệu có nhiều section ngắn.`
      );
    }

    // Normalize, dedup (FIX #1 + #9), re-index
    const chunks = dedupBoundary(filtered.map(normalizeChunk));
    chunks.forEach((c, i) => (c.index = i));

    // Debug dump
    try {
      fs.mkdirSync(path.dirname(DEBUG_PATH), { recursive: true });
      fs.writeFileSync(DEBUG_PATH, JSON.stringify(chunks, null, 2));
    } catch {}

    if (anyWindowFailed) {
      console.warn("⚠️  Some windows used rule-based fallback");
    }

    console.log(`✅ aiChunkText: ${chunks.length} chunks (${droppedCount} dropped)`);
    return chunks;

  } catch (err) {
    console.error("❌ aiChunkText hard error:", err.message);
    return chunkText(text).map((c, i) => ({
      ...c,
      index  : i,
      section: c.section || "",
      topic  : "general",
    }));
  }
};

module.exports = { aiChunkText };