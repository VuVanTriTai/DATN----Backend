"use strict";

// ─────────────────────────────────────────────────────────────────
// utils/aiChunkText.js — LLM-POWERED SEMANTIC CHUNKER (Groq)
//
// When to use instead of chunkText.js:
//   - Document has no Markdown headings (e.g. raw OCR, contract text)
//   - You need section titles inferred from content, not just headings
//   - Precision > speed is required
//
// Flow:
//   1. Pre-chunk text into windows (to stay inside context limit)
//   2. For each window, ask LLM to produce JSON chunk array
//   3. Repair JSON if model adds prose/markdown around it
//   4. Merge, re-index, deduplicate boundary overlap
//   5. Fallback to rule-based chunkText on any hard failure
// ─────────────────────────────────────────────────────────────────

const Groq   = require("groq-sdk");
const fs     = require("fs");
const path   = require("path");
const { chunkText } = require("./chunkText"); // rule-based fallback

const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const DEBUG_PATH = path.join(__dirname, "../debug/debug_ai_chunks.json");

// ─── tunables ────────────────────────────────
const MODEL         = "llama-3.1-8b-instant";
const TEMPERATURE   = 0.1;   // deterministic
const WINDOW_CHARS  = 8000;  // chars per LLM window (safe for 8b ctx)
const WINDOW_OVERLAP= 400;   // overlap chars between windows
const MIN_WORDS     = 30;    // discard tiny chunks
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Extract the first JSON array from an arbitrary string.
 * Handles:
 *   - Bare JSON
 *   - ```json ... ``` fences
 *   - Prose before/after the array
 */
const extractJsonArray = (raw) => {
  // 1. Try direct parse first
  try { return JSON.parse(raw); } catch {}

  // 2. Strip code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // 3. Find first '[' and match bracket depth
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
 * Splits at paragraph boundaries when possible to avoid mid-sentence cuts.
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

    // Try to break at a paragraph boundary near the window end
    const slice     = text.slice(pos, end);
    const lastBreak = slice.lastIndexOf("\n\n");
    const breakAt   = lastBreak > WINDOW_CHARS * 0.5
      ? lastBreak + 2           // after the \n\n
      : slice.length;           // fallback: hard cut

    windows.push(text.slice(pos, pos + breakAt));
    pos += breakAt - WINDOW_OVERLAP; // move forward with overlap
  }

  return windows;
};

/**
 * Build the prompt for a single window.
 */
const buildPrompt = (windowText, windowIndex, totalWindows) => `
You are a document chunking engine. Your ONLY output is a valid JSON array — no prose, no markdown, no explanation.

TASK: Split the document excerpt into semantic chunks.

RULES:
1. Each chunk = one self-contained idea, concept, or procedure.
2. NEVER cut mid-sentence, mid-table, mid-code block, or mid-list.
3. Keep tables INTACT inside a single chunk.
4. Keep code examples with the concept they illustrate.
5. Detect a concise section title from context; use "" if none.
6. Each chunk must have ≥ ${MIN_WORDS} words.

OUTPUT FORMAT (strict — no keys other than these):
[
  { "section": "<title or empty string>", "content": "<full chunk text>" },
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
 * Call the LLM for one text window. Returns array of raw chunk objects.
 */
const chunkWindow = async (windowText, windowIndex, totalWindows) => {
  const res = await groq.chat.completions.create({
    model      : MODEL,
    temperature: TEMPERATURE,
    messages: [
      {
        role   : "system",
        content: "You are a document chunking engine. Output ONLY a valid JSON array. No prose, no markdown fences, no explanation.",
      },
      {
        role   : "user",
        content: buildPrompt(windowText, windowIndex, totalWindows),
      },
    ],
  });

  const raw = res.choices?.[0]?.message?.content || "";
  const parsed = extractJsonArray(raw);

  if (!parsed || !Array.isArray(parsed)) {
    console.warn(`⚠️  Window ${windowIndex}: JSON parse failed, will use fallback for this window`);
    return null; // signal failure for this window
  }

  return parsed;
};

/**
 * Normalize a raw chunk object from the LLM.
 */
const normalizeChunk = (raw, index) => {
  const content  = (raw.content || "").trim();
  const section  = (raw.section || "").trim();
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return { index, section, content, wordCount };
};

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

const aiChunkText = async (text) => {
  if (!text || text.length < 50) return [];

  try {
    const windows = buildWindows(text);
    console.log(`🧠 aiChunkText: ${windows.length} window(s) for ${text.length} chars`);

    const allRaw = [];
    let anyWindowFailed = false;

    for (let i = 0; i < windows.length; i++) {
      const result = await chunkWindow(windows[i], i, windows.length);
      if (result === null) {
        anyWindowFailed = true;
        // Fallback for this window: use rule-based chunker
        const fallback = chunkText(windows[i]);
        for (const fb of fallback) {
          allRaw.push({ section: fb.section || "", content: fb.content });
        }
      } else {
        allRaw.push(...result);
      }
    }

    // Filter, normalize, re-index
    const chunks = allRaw
      .filter(c => (c.content || "").split(/\s+/).filter(Boolean).length >= MIN_WORDS)
      .map(normalizeChunk);

    // Re-number after filtering
    chunks.forEach((c, i) => (c.index = i));

    // Debug dump
    try {
      fs.mkdirSync(path.dirname(DEBUG_PATH), { recursive: true });
      fs.writeFileSync(DEBUG_PATH, JSON.stringify(chunks, null, 2));
    } catch {}

    if (anyWindowFailed) {
      console.warn("⚠️  Some windows used rule-based fallback");
    }
    console.log(`✅ aiChunkText: ${chunks.length} chunks`);
    return chunks;

  } catch (err) {
    console.error("❌ aiChunkText hard error:", err.message);
    // Full fallback
    return chunkText(text).map((c, i) => ({ ...c, index: i, section: c.section || "" }));
  }
};

module.exports = { aiChunkText };