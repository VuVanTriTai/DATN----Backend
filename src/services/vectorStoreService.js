// services/vectorStoreService.js
"use strict";

const Chunk = require("../models/Chunk");
const { generateEmbeddingsBatch } = require("./embeddingService");
const fs = require("fs");
const path = require("path");

// Debug path
const DEBUG_PATH = path.join(__dirname, "../debug/debug_chunks_saved.json");

const mongoose = require("mongoose");
const { splitIntoPropositions } = require("../utils/chunkText");

// ─────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────

const saveChunksWithEmbeddings = async (planId, chunks) => {
  try {
    if (!chunks?.length) {
      console.warn("⚠️ No chunks to save");
      return;
    }

    console.log(`📦 Processing ${chunks.length} parent chunks...`);

    // 1. FILTER chunk hợp lệ
    const validParentChunks = chunks.filter(
      (c) => c.content && c.content.length >= 20
    );

    if (!validParentChunks.length) {
      console.warn("⚠️ No valid parent chunks after filtering");
      return;
    }

    // 2. PHÂN TÁCH PROPOSITIONS (CHILD CHUNKS)
    const rawDocsToSave = []; // Chứa { id, planId, chunkIndex, content, section, isChild, parentId, wordCount }

    for (let i = 0; i < validParentChunks.length; i++) {
      const parentChunk = validParentChunks[i];
      const parentId = new mongoose.Types.ObjectId();

      // Thêm Parent Chunk
      rawDocsToSave.push({
        _id: parentId,
        planId,
        chunkIndex: parentChunk.index,
        content: parentChunk.content,
        section: parentChunk.section || "",
        isChild: false,
        parentId: null,
        wordCount: parentChunk.wordCount || 0
      });

      // Sinh các child propositions
      const children = splitIntoPropositions(parentChunk);
      console.log(`   - Parent [Index ${parentChunk.index}]: Generated ${children.length} child propositions.`);
      
      for (let j = 0; j < children.length; j++) {
        rawDocsToSave.push({
          _id: new mongoose.Types.ObjectId(),
          planId,
          // Child share index với parent nhưng có định danh child
          chunkIndex: parentChunk.index,
          content: children[j].content,
          section: parentChunk.section || "",
          isChild: true,
          parentId: parentId,
          wordCount: children[j].wordCount
        });
      }
    }

    if (!rawDocsToSave.length) {
      console.warn("⚠️ No docs to save");
      return;
    }

    // 3. GENERATE EMBEDDINGS TRÊN TOÀN BỘ BATCH (CẢ PARENT VÀ CHILD)
    const texts = rawDocsToSave.map((doc) => doc.content);
    console.log(`🧠 Generating embeddings for batch of ${rawDocsToSave.length} total nodes (Parents + Children)...`);
    
    const embeddings = await generateEmbeddingsBatch(texts, "passage", 16);

    if (!embeddings || embeddings.length !== rawDocsToSave.length) {
      throw new Error("Embedding batch mismatch");
    }

    // 4. BUILD DB DOCUMENTS
    const preparedDocs = [];
    for (let i = 0; i < rawDocsToSave.length; i++) {
      const doc = rawDocsToSave[i];
      const vector = embeddings[i];

      // Validate embedding
      if (!Array.isArray(vector) || vector.length < 100) {
        console.warn(`⚠️ Skip invalid embedding for node content: ${doc.content.substring(0, 30)}`);
        continue;
      }

      preparedDocs.push({
        _id: doc._id,
        planId: doc.planId,
        chunkIndex: doc.chunkIndex,
        content: doc.content,
        section: doc.section,
        isChild: doc.isChild,
        parentId: doc.parentId,
        embedding: vector,
        metadata: {
          wordCount: doc.wordCount || 0
        }
      });
    }

    if (!preparedDocs.length) {
      console.warn("⚠️ No valid docs to insert after embedding check");
      return;
    }

    // 5. SAVE DB
    console.log(`💾 Inserting ${preparedDocs.length} nodes into Chunk collection...`);

    await Chunk.insertMany(preparedDocs, {
      ordered: false
    });

    console.log(`✅ Saved ${preparedDocs.length} nodes successfully (Parents & Children)`);

    // 6. DEBUG FILE
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