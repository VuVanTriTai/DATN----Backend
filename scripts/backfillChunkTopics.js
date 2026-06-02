// scripts/backfillChunkTopics.js
// ─────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION: Thêm field `topic` cho tất cả Chunk cũ trong DB
// mà không cần tạo lại embedding.
//
// Chạy: node scripts/backfillChunkTopics.js
// ─────────────────────────────────────────────────────────────────
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const Chunk = require("../src/models/Chunk");
const { classifyTopic } = require("../src/utils/topicClassifier");

const BATCH_SIZE = 200;

async function backfill() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  let processed = 0;
  let updated   = 0;
  let skip      = 0;

  const total = await Chunk.countDocuments({});
  console.log(`📦 Total chunks in DB: ${total}`);

  // Xử lý theo batch để không OOM
  while (true) {
    const batch = await Chunk.find({})
      .select("_id content section topic")
      .skip(skip)
      .limit(BATCH_SIZE)
      .lean();

    if (!batch.length) break;

    const ops = [];

    for (const chunk of batch) {
      processed++;

      // Bỏ qua nếu đã có topic khác "general" hoặc đã có topic
      if (chunk.topic && chunk.topic !== "general") {
        continue;
      }

      const topic = classifyTopic(chunk.content, chunk.section);

      ops.push({
        updateOne: {
          filter: { _id: chunk._id },
          update: { $set: { topic } }
        }
      });
    }

    if (ops.length) {
      await Chunk.bulkWrite(ops, { ordered: false });
      updated += ops.length;
    }

    skip += BATCH_SIZE;

    const pct = ((processed / total) * 100).toFixed(1);
    console.log(`  [${pct}%] Processed ${processed}/${total} | Updated ${updated}`);
  }

  console.log(`\n✅ Done. Processed: ${processed} | Updated: ${updated}`);
  await mongoose.disconnect();
}

backfill().catch(err => {
  console.error("❌ Backfill failed:", err.message);
  process.exit(1);
});
