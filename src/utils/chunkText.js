// utils/chunkText.js — TABLE-AWARE CHUNKER
"use strict";

const TARGET_CHUNK_WORDS = 280;
const MIN_CHUNK_WORDS    = 60;
const OVERLAP_LINES      = 3; // overlap giữa chunks

// ─────────────────────────────────────────────
// LINE CLASSIFICATION
// ─────────────────────────────────────────────

/**
 * Classify từng dòng text
 */
const classifyLine = (line) => {
  if (!line.trim())                     return "blank";
  if (/^\s*\|/.test(line))             return "table";     // Markdown table row
  if (/^#{1,6}\s/.test(line.trim()))   return "heading";   // # Heading
  if (/^[\s]*[-*+]\s/.test(line))      return "list";      // - Bullet point
  return "text";
};

/**
 * Group liên tiếp các dòng cùng type thành blocks
 * Table blocks KHÔNG bao giờ bị split
 */
const groupIntoBlocks = (lines) => {
  const blocks = [];
  let current  = null;

  for (const line of lines) {
    const type = classifyLine(line);

    if (type === "blank") {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }

    // Heading luôn tạo block riêng
    if (type === "heading") {
      if (current) blocks.push(current);
      current = { type: "heading", lines: [line] };
      blocks.push(current);
      current = null;
      continue;
    }

    // Type thay đổi → flush block cũ
    if (current && current.type !== type) {
      blocks.push(current);
      current = null;
    }

    if (!current) current = { type, lines: [] };
    current.lines.push(line);
  }

  if (current) blocks.push(current);
  return blocks;
};

// ─────────────────────────────────────────────
// MAIN CHUNKER
// ─────────────────────────────────────────────

/**
 * Chunk text với bảo đảm:
 * 1. Table blocks KHÔNG bị cắt giữa chừng
 * 2. Mỗi chunk ~TARGET_CHUNK_WORDS
 * 3. Overlap để maintain context cho RAG
 */
const chunkText = (text) => {
  if (!text || typeof text !== "string") return [];

  const lines  = text.split("\n");
  const blocks = groupIntoBlocks(lines);
  const chunks = [];

  let currentLines = [];
  let currentWords = 0;
  let chunkIndex   = 0;

  const flush = () => {
    const content = currentLines.join("\n").trim();
    const wc      = content.split(/\s+/).filter(Boolean).length;
    
    if (wc >= MIN_CHUNK_WORDS) {
      chunks.push({ 
        index: chunkIndex++, 
        content, 
        wordCount: wc 
      });
    }

    // Overlap: giữ lại OVERLAP_LINES dòng cuối
    const overlapLines = currentLines.slice(-OVERLAP_LINES);
    currentLines = overlapLines;
    currentWords = overlapLines.join(" ").split(/\s+/).filter(Boolean).length;
  };

  for (const block of blocks) {
    const blockText  = block.lines.join("\n");
    const blockWords = blockText.split(/\s+/).filter(Boolean).length;

    // ── TABLE BLOCK: Không bao giờ split ──
    if (block.type === "table") {
      // Nếu table + content hiện tại quá lớn → flush trước
      if (
        currentWords + blockWords > TARGET_CHUNK_WORDS * 1.5 && 
        currentWords > MIN_CHUNK_WORDS
      ) {
        flush();
      }

      // Add whole table
      currentLines.push(...block.lines);
      currentWords += blockWords;

      // Bảng lớn → flush ngay
      if (blockWords > TARGET_CHUNK_WORDS * 0.8) {
        flush();
      }
      continue;
    }

    // ── TEXT/LIST/HEADING: Add từng dòng ──
    for (const line of block.lines) {
      const lineWords = line.split(/\s+/).filter(Boolean).length;

      // Kiểm tra có cần flush không
      if (
        currentWords + lineWords > TARGET_CHUNK_WORDS &&
        currentWords >= MIN_CHUNK_WORDS
      ) {
        flush();
      }

      currentLines.push(line);
      currentWords += lineWords;
    }
  }

  // Flush chunk cuối
  if (currentWords >= MIN_CHUNK_WORDS) {
    const content = currentLines.join("\n").trim();
    const wc      = content.split(/\s+/).filter(Boolean).length;
    
    if (wc >= MIN_CHUNK_WORDS) {
      chunks.push({ 
        index: chunkIndex++, 
        content, 
        wordCount: wc 
      });
    }
  }

  console.log(`[chunkText] Created ${chunks.length} chunks from ${lines.length} lines`);
  return chunks;
};

module.exports = { chunkText };
