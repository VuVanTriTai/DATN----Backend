// services/vectorStoreService.js
"use strict";

const Chunk = require("../models/Chunk");
const { generateEmbeddingsBatch } = require("./embeddingService");
const fs = require("fs");
const path = require("path");

// Debug path
const DEBUG_PATH = path.join(__dirname, "../debug/debug_chunks_saved.json");

// ─────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────

const saveChunksWithEmbeddings = async (planId, chunks) => {
  try {
    if (!chunks?.length) {
      console.warn("⚠️ No chunks to save");
      return;
    }

    console.log(`📦 Processing ${chunks.length} chunks...`);

    // 1. FILTER chunk hợp lệ
    const validChunks = chunks.filter(
      (c) => c.content && c.content.length >= 20
    );

    if (!validChunks.length) {
      console.warn("⚠️ No valid chunks after filtering");
      return;
    }

    // 2. EMBEDDING BATCH (🚀 QUAN TRỌNG)
    const texts = validChunks.map((c) => c.content);

    console.log("🧠 Generating embeddings (batch)...");
    const embeddings = await generateEmbeddingsBatch(texts, "passage", 16);

    if (!embeddings || embeddings.length !== validChunks.length) {
      throw new Error("Embedding mismatch");
    }

    // 3. BUILD DOCUMENTS
    const preparedDocs = [];

    for (let i = 0; i < validChunks.length; i++) {
      const chunk = validChunks[i];
      const vector = embeddings[i];

      // Validate embedding
      if (!Array.isArray(vector) || vector.length < 100) {
        console.warn(`⚠️ Skip invalid embedding at chunk ${chunk.index}`);
        continue;
      }

      preparedDocs.push({
        planId,
        chunkIndex: chunk.index,
        content: chunk.content,
        section: chunk.section || "",
        embedding: vector,
        metadata: {
          wordCount: chunk.wordCount || 0
        }
      });
    }

    if (!preparedDocs.length) {
      console.warn("⚠️ No valid docs to insert");
      return;
    }

    // 4. SAVE DB
    console.log(`💾 Inserting ${preparedDocs.length} chunks...`);

    await Chunk.insertMany(preparedDocs, {
      ordered: false // tránh fail toàn bộ nếu 1 doc lỗi
    });

    console.log(`✅ Saved ${preparedDocs.length} chunks`);

    // 5. DEBUG FILE
    try {
      fs.writeFileSync(
        DEBUG_PATH,
        JSON.stringify(preparedDocs.slice(0, 50), null, 2),
        "utf-8"
      );
      console.log("🧪 Debug saved: debug_chunks_saved.json");
    } catch (e) {
      console.warn("⚠️ Cannot save debug file");
    }

  } catch (error) {
    console.error("❌ Vector Store Error:", error.message);
    throw error;
  }
};

module.exports = { saveChunksWithEmbeddings };