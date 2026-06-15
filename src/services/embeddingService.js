"use strict";

const { pipeline } = require("@xenova/transformers");

let extractor = null;
let loadPromise = null;

const MAX_CHARS = 500;

/**
 * Tải Model theo cơ chế Singleton và đợi tuyệt đối
 */
const getExtractor = async () => {
  if (extractor) return extractor;

  if (!loadPromise) {
    console.log("🧠 Đang khởi tạo Model Embedding (Local)...");
    loadPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      execution_providers: ['cpu'], // Ép chạy CPU để tránh lỗi Driver GPU
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

const cleanText = (text) => {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().substring(0, MAX_CHARS);
};

/**
 * Tạo 1 vector
 */
const generateEmbedding = async (text, type = "passage", retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!text || text.trim().length === 0) return null;

      const pipe = await getExtractor();

      // all-MiniLM-L6-v2 không cần prefix — type được nhận để tương thích
      // khi nâng cấp sang multilingual-e5 sau này (e5 yêu cầu "query: "/"passage: " prefix)
      // TODO: nếu đổi model sang e5, bỏ comment 2 dòng dưới và xóa dòng `const input = cleanText(text)`:
      // const prefix = type === "query" ? "query: " : "passage: ";
      // const input = prefix + cleanText(text);
      const input = cleanText(text);

      const output = await pipe(input, {
        pooling: "mean",
        normalize: true,
      });

      const vector = Array.from(output.data);

      // Guard phát hiện dimension bất thường sớm (chỉ log, không throw)
      if (vector.length !== 384) {
        console.warn(`⚠️ Embedding dimension không mong đợi: ${vector.length} (expected 384)`);
      }

      return vector;

    } catch (err) {
      if (attempt === retries) {
        console.error(`❌ Lỗi tạo vector đơn sau ${retries} lần thử:`, err.message);
        return null;
      }
      const delay = 300 * attempt; // 300ms, 600ms, 900ms
      console.warn(`⚠️ Retry ${attempt}/${retries} sau ${delay}ms — lỗi: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
};

/**
 * Tạo batch vector (Sửa lỗi logic chia tách mảng)
 */
const generateEmbeddingsBatch = async (texts, type = "passage", batchSize = 2) => {
  try {
    if (!texts || texts.length === 0) return [];

    const pipe = await getExtractor();
    const results = [];

    // Xử lý từng batch nhỏ để không treo RAM
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const inputs = batch.map(t => cleanText(t));

      const outputs = await pipe(inputs, {
        pooling: "mean",
        normalize: true
      });

      // Logic chia mảng dữ liệu chính xác
      const vectorSize = outputs.data.length / batch.length;
      for (let j = 0; j < batch.length; j++) {
        const start = j * vectorSize;
        const end = (j + 1) * vectorSize;
        results.push(Array.from(outputs.data.slice(start, end)));
      }

      console.log(`⏳ Đã xử lý: ${Math.min(i + batchSize, texts.length)}/${texts.length} chunks`);
    }

    return results;
  } catch (err) {
    console.error("❌ Lỗi tạo vector batch:", err.message);
    return new Array(texts.length).fill(null);
  }
};

module.exports = { generateEmbedding, generateEmbeddingsBatch };