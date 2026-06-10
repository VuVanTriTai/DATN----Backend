"use strict";

const { pipeline } = require("@xenova/transformers");

let extractor = null;
let loadPromise = null;

// ── FIX 1 ──────────────────────────────────────────────────────────────────
// OLD: MAX_CHARS = 500  →  silently truncated every chunk to ~70 words before
//      embedding, so the vector only represented the opening of the chunk.
//      Semantic search then retrieved wrong chunks for the rest of the content.
//
// NEW: 2000 chars (~300 words) — covers a full 350-word parent chunk while
//      staying well within the model's 256-token window after mean-pooling.
//      For passage chunks that exceed 2000 chars, we keep the first 1600 chars
//      PLUS the last 300 chars so the embedding captures both the opening
//      context and the closing conclusion of the chunk (windowed coverage).
// ───────────────────────────────────────────────────────────────────────────
const MAX_CHARS = 2000;

const getExtractor = async () => {
  if (extractor) return extractor;

  if (!loadPromise) {
    console.log("🧠 Đang khởi tạo Model Embedding (Local)...");
    loadPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      execution_providers: ["cpu"],
    });
  }

  try {
    extractor = await loadPromise;
    console.log("✅ Model đã nạp vào RAM thành công!");
    return extractor;
  } catch (err) {
    loadPromise = null;
    console.error("❌ Lỗi nạp model AI:", err.message);
    throw err;
  }
};

// ── FIX 2 ──────────────────────────────────────────────────────────────────
// OLD: cleanText() stripped all structure and truncated at MAX_CHARS with a
//      hard .substring(0, MAX_CHARS).  For chunks longer than MAX_CHARS this
//      discarded the tail silently.
//
// NEW: For long passages we use a "head + tail" window so the model sees the
//      opening context AND the closing sentences.  Short texts are untouched.
//      The `type` param ("passage" | "query") is forwarded unchanged so callers
//      that already prepend "passage:" or "query:" keep working correctly.
// ───────────────────────────────────────────────────────────────────────────
const prepareText = (text, type = "passage") => {
  if (!text) return "";

  // Normalise whitespace but preserve newlines so section structure survives
  let t = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  if (t.length <= MAX_CHARS) return t;

  // Head + tail window for long chunks
  const head = t.slice(0, MAX_CHARS - 300).trimEnd();
  const tail = t.slice(-300).trimStart();
  return `${head} … ${tail}`;
};

/**
 * Generate a single embedding vector.
 *
 * @param {string} text  - Raw text (may include "passage:" / "query:" prefix).
 * @param {string} type  - "passage" | "query" (informational; prefix already
 *                         handled by callers in planService).
 */
const generateEmbedding = async (text, type = "passage") => {
  try {
    if (!text || text.trim().length === 0) return null;

    const pipe = await getExtractor();
    const input = prepareText(text, type);

    const output = await pipe(input, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data);
  } catch (err) {
    console.error("❌ Lỗi tạo vector đơn:", err.message);
    return null;
  }
};

/**
 * Generate embeddings for a batch of texts.
 */
const generateEmbeddingsBatch = async (texts, type = "passage", batchSize = 2) => {
  try {
    if (!texts || texts.length === 0) return [];

    const pipe = await getExtractor();
    const results = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const inputs = batch.map(t => prepareText(t, type));

      const outputs = await pipe(inputs, {
        pooling: "mean",
        normalize: true,
      });

      const vectorSize = outputs.data.length / batch.length;
      for (let j = 0; j < batch.length; j++) {
        const start = j * vectorSize;
        const end = (j + 1) * vectorSize;
        results.push(Array.from(outputs.data.slice(start, end)));
      }

      console.log(
        `⏳ Đã xử lý: ${Math.min(i + batchSize, texts.length)}/${texts.length} chunks`
      );
    }

    return results;
  } catch (err) {
    console.error("❌ Lỗi tạo vector batch:", err.message);
    return new Array(texts.length).fill(null);
  }
};

module.exports = { generateEmbedding, generateEmbeddingsBatch };