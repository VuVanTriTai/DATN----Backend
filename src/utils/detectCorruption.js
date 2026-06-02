"use strict";

const detectCorruption = (text) => {
  if (!text) return false;

  let score = 0;

  // bảng rỗng kiểu |   |
  const emptyTableLines = (text.match(/^\|\s*\|$/gm) || []).length;

  if (emptyTableLines > 5) score += 2;

  // nhiều ký tự lạ
  const weirdChars = (text.match(/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF\s]/g) || []).length;

  if (weirdChars > 50) score += 1;

  // dòng quá ngắn liên tục
  const shortLines = text
    .split("\n")
    .filter(l => l.trim().length > 0 && l.trim().length < 3).length;

  if (shortLines > 20) score += 1;

  return score >= 2;
};

module.exports = { detectCorruption };