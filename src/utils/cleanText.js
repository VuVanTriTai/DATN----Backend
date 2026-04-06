// utils/cleanText.js — TABLE-PRESERVING CLEANER
"use strict";

/**
 * cleanText: làm sạch nhưng BẢO TOÀN:
 *  - Markdown table rows (| ... |)
 *  - Heading structure (# ...)  
 *  - List structure (- * +)
 */
const cleanText = (text) => {
  if (!text || typeof text !== "string") return "";

  return text
    .split("\n")
    .map((line) => {
      // BẢO TOÀN Markdown table rows
      if (/^\s*\|/.test(line)) return line;
      
      // BẢO TOÀN headings
      if (/^#{1,6}\s/.test(line.trim())) return line;
      
      // BẢO TOÀN lists
      if (/^[\s]*[-*+]\s/.test(line)) return line;

      // Clean normal lines: reduce excessive whitespace
      return line
        .replace(/\s{3,}/g, "  ")   // >2 spaces → 2 spaces
        .replace(/\t/g, "  ")       // tab → 2 spaces
        .trimEnd();                 // remove trailing spaces
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")     // max 2 consecutive blank lines
    .trim();
};

module.exports = { cleanText };
