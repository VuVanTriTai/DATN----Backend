// utils/cleanText.js — DOCLING-AWARE CLEANER v3
"use strict";

/**
 * cleanText v3 — 4 nhóm fix chính:
 *
 *  FIX 1: Unicode spacing repair
 *         "Ki ể u" → "Kiểu" (combining diacritics bị tách bởi space)
 *         "C s d li u" → không thể tự fix (dấu đã DROP) → cần fix ở tầng Python
 *
 *  FIX 2: Broken URL removal
 *         "http://msdn.microsoft.com/e us/library/..." → xoá
 *
 *  FIX 3: Garbage fragment removal
 *         "(3)) 50", "- ') 559 - 555", số trang lẻ, noise PDF...
 *
 *  FIX 4: Broken table detection & flattening
 *         Nhiều dòng ngắn liên tiếp → "col1 | col2 | col3"
 *
 * ─── GIỚI HẠN CỦA NODE.JS LAYER ───────────────────────────────────────────
 *  Trường hợp "C s d li u nâng cao" (= "Cơ sở dữ liệu nâng cao"):
 *  Dấu tiếng Việt đã bị DROP hoàn toàn ở tầng PDF parser (Docling/pdfplumber).
 *  cleanText.js KHÔNG THỂ khôi phục dấu đã mất.
 *  → Fix cần thực hiện trong docling_extract.py:
 *    Option 1: Thêm fallback sang pymupdf (fitz) khi detect text bị mất dấu
 *    Option 2: Thêm fallback sang pdfplumber với layout_analysis=True
 *    Option 3: Detect heuristic (tỷ lệ ký tự ASCII/Latin cao bất thường cho tiếng Việt)
 *              → trigger re-extract với engine khác
 * ────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────
// HTML ENTITY DECODER
// ─────────────────────────────────────────────
const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ',
  '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&#x27;': "'", '&#x2F;': '/', '&#47;': '/',
};

const decodeHtmlEntities = (str) => {
  let r = str.replace(/&[a-zA-Z]+;/g, (m) => HTML_ENTITIES[m] || m);
  r = r.replace(/&#(\d+);/g, (_, c) => {
    const n = parseInt(c, 10);
    return (n < 32 && n !== 9 && n !== 10 && n !== 13) ? '' : String.fromCodePoint(n);
  });
  r = r.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    const n = parseInt(h, 16);
    return (n < 32 && n !== 9 && n !== 10 && n !== 13) ? '' : String.fromCodePoint(n);
  });
  return r;
};

// ─────────────────────────────────────────────
// FIX 1: UNICODE SPACING REPAIR
// ─────────────────────────────────────────────
/**
 * Xử lý trường hợp combining diacritical marks bị tách khỏi base char bởi space.
 *
 * Ví dụ lỗi từ PDF:
 *   "Ki e\u0309 u" (space trước combining hook above) → "Kiểu"
 *   "Kiu\u0309" sau NFC → "Kiểu"  ✓
 *
 * Combining mark ranges:
 *   U+0300–U+036F  Latin/Greek combining diacritics (bao gồm dấu tiếng Việt dạng combining)
 *   U+1AB0–U+1AFF  Combining Diacritical Marks Extended
 *   U+1DC0–U+1DFF  Combining Diacritical Marks Supplement
 */
const fixUnicodeSpacing = (str) => {
  // Bước A: Xoá space đứng TRƯỚC combining mark
  let result = str.replace(/ ([\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF])/g, '$1');

  // Bước B: Xoá space đứng SAU combining mark (tách ngược)
  result = result.replace(/([\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF]) /g, '$1');

  // Bước C: Re-normalize NFC → ghép base + combining → precomposed char
  result = result.normalize('NFC');

  return result;
};

// ─────────────────────────────────────────────
// FIX 2: BROKEN URL REMOVAL
// ─────────────────────────────────────────────
/**
 * 3 loại URL rác từ PDF kỹ thuật:
 *
 * Type A — URL bị vỡ dòng, có space bên trong:
 *   "http://msdn.microsoft.com/e us/library/ms187928.asp"
 *
 * Type B — URL đứng một mình cả dòng (không có ngữ cảnh văn bản):
 *   "https://docs.microsoft.com/en-us/sql/t-sql/..."
 *
 * Type C — Fragment path lẻ đứng một mình (phần sau khi URL bị ngắt dòng):
 *   "e us/library/ms187928.asp"
 */
const removeBrokenUrls = (str) => {
  // Type A: URL có space trong body
  let result = str.replace(/https?:\/\/\S+\s+\S*(?:\.\w+)?/g, (match) => {
    const body = match.replace(/^https?:\/\//, '');
    return /\s/.test(body) ? '' : match;
  });

  // Type B: URL standalone cả dòng
  result = result.replace(/^https?:\/\/[^\s]+\s*$/gm, '');

  // Type C: Path fragment lẻ — có dạng "word space word/word.ext"
  // Ví dụ: "e us/library/ms187928.asp" hoặc "en us/sql/functions/..."
  result = result.replace(/^[a-z]{1,5}\s+[\w/.\-]+\.\w{2,5}\s*$/gim, '');

  return result;
};

// ─────────────────────────────────────────────
// FIX 3: GARBAGE FRAGMENT REMOVAL
// ─────────────────────────────────────────────
/**
 * Các pattern noise phổ biến từ PDF extraction:
 *
 * Pattern            Ví dụ                  Nguồn gốc
 * ─────────────────────────────────────────────────────
 * (N)) số            (3)) 50                Broken footnote ref
 * -')+số             - ') 559 - 555         Phone/code bị OCR sai
 * ) số               ) 50                   Closing paren + page num
 * Số đơn lẻ          42                     Page number
 * Dải số             50, 100 - 200          Page range
 * Separator          ─────────              Horizontal rule PDF
 * Footnote lẻ        1.  2)                 Footnote number
 * Ký tự đặc biệt     §  ¶  ©               Symbol rác
 */
const GARBAGE_PATTERNS = [
  /^\(\d+\)\)\s*[\d/]+/,                        // (3)) 50 | (3)) /CAST
  /^-\s*['"`]\)\s*[\d\s\-]+$/,                  // - ') 559 - 555 - 1212
  /^\)\s*\d+\s*$/,                              // ) 50
  /^\(\s*\d+\s*\)\s*$/,                         // ( 3 )
  /^\d{1,4}\s*$/,                               // 42  (page num)
  /^[\d\s,\-–—]+$/,                             // 50, 100 - 200  (page range)
  /^[.\-_=*~`|]{3,}\s*$/,                       // ─────  =====  |||
  /^\d{1,2}[.)]\s*$/,                           // 1.  2)  (footnote)
  /^[^\w\u00C0-\u024F\u1E00-\u1EFF]{1,3}$/,    // §  ¶  ©  (non-word symbols)
];

const removeGarbageFragments = (str) =>
  str
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t === '') return true; // giữ dòng trống
      return !GARBAGE_PATTERNS.some((pat) => pat.test(t));
    })
    .join('\n');

// ─────────────────────────────────────────────
// FIX 4: BROKEN TABLE DETECTION & FLATTENING
// ─────────────────────────────────────────────
/**
 * PDF kỹ thuật có bảng bị vỡ: mỗi cell là một dòng riêng.
 *
 * Ví dụ input (bảng SQL data types):
 *   int
 *   4 bytes
 *   -2,147,483,648
 *   2,147,483,647
 *
 * Output:
 *   int | 4 bytes | -2,147,483,648 | 2,147,483,647
 *
 * Tuning parameters:
 *   SHORT_THRESHOLD = 45  — SQL type names, keywords thường < 45 chars
 *   MIN_RUN = 3           — ít nhất 3 cell liên tiếp mới coi là broken table
 *
 * Không động đến:
 *   - Real markdown tables (|...|)
 *   - Headings (#)
 *   - Lists (- * 1.)
 *   - Code blocks (```)
 *   - Câu văn (kết thúc . : ? ! hoặc dài hơn SHORT_THRESHOLD)
 */
const SHORT_THRESHOLD = 45;
const MIN_RUN = 3;

const isSentenceLike = (t) =>
  t.endsWith('.') || t.endsWith(':') || t.endsWith('?') ||
  t.endsWith('!') || t.length > SHORT_THRESHOLD;

const isStructuralLine = (t) =>
  t === '' ||
  t.startsWith('|') ||
  /^#{1,6}\s/.test(t) ||
  /^[-*+]\s/.test(t) ||
  /^\d+\.\s/.test(t) ||
  t.startsWith('```');

const flattenBrokenTables = (str) => {
  const lines = str.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    if (isStructuralLine(t) || isSentenceLike(t)) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Thu thập run
    const run = [t];
    let j = i + 1;
    while (j < lines.length) {
      const nt = lines[j].trim();
      if (isStructuralLine(nt) || isSentenceLike(nt)) break;
      run.push(nt);
      j++;
    }

    if (run.length >= MIN_RUN) {
      result.push(run.filter(Boolean).join(' | '));
      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
};

// ─────────────────────────────────────────────
// MARKDOWN ESCAPE CLEANUP
// ─────────────────────────────────────────────
const cleanMarkdownEscapes = (str) =>
  str
    .replace(/\\_/g, '_').replace(/\\\*/g, '*')
    .replace(/\\\[/g, '[').replace(/\\\]/g, ']')
    .replace(/\\#/g, '#').replace(/\\\|/g, '|');

// ─────────────────────────────────────────────
// MAIN CLEANER
// ─────────────────────────────────────────────
const cleanText = (text) => {
  if (!text || typeof text !== 'string') return '';

  let result = text.normalize('NFC');           // Bước 1: NFC
  result = decodeHtmlEntities(result);          // Bước 2: HTML entities
  result = fixUnicodeSpacing(result);           // Bước 3: Unicode spacing fix
  result = cleanMarkdownEscapes(result);        // Bước 4: Markdown escapes
  result = removeBrokenUrls(result);            // Bước 5: Broken URLs
  result = removeGarbageFragments(result);      // Bước 6: Garbage fragments
  result = flattenBrokenTables(result);         // Bước 7: Broken tables

  // Bước 8: Per-line cleanup (bảo toàn markdown structure)
  let inCodeBlock = false;
  result = result
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) { inCodeBlock = !inCodeBlock; return line; }
      if (inCodeBlock) return line;
      if (/^\s*\|/.test(line)) return line.trimEnd();
      if (/^#{1,6}\s/.test(line.trim())) return line;
      if (/^[\s]*[-*+]\s/.test(line)) return line;
      if (/^[\s]*\d+\.\s/.test(line)) return line;
      return line.replace(/\s{3,}/g, '  ').replace(/\t/g, '  ').trimEnd();
    })
    .join('\n');

  result = result.replace(/\n{3,}/g, '\n\n');  // Bước 9: Blank lines
  result = result.replace(/^\d+\.\s*$/gm, ''); // Bước 10: Slide artifacts

  // Bước 11: Unicode rác
  result = result
    .replace(/\uFFFD/g, '').replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Bước 12: Vertical fragmentation repair
  // Chữ bị vỡ thành từng ký tự/âm tiết trên mỗi dòng
  const lines = result.split('\n');
  const defrag = [];
  let buf = [];
  let emptyCount = 0;

  const flush = () => {
    if (buf.length > 0) {
      defrag.push(buf.join(' ').replace(/\s{2,}/g, ' '));
      buf = [];
    }
  };

  for (const line of lines) {
    const t = line.trim();
    if (t === '') {
      emptyCount++;
      if (emptyCount >= 2 && buf.length > 0) { flush(); defrag.push(''); }
      else if (buf.length === 0) defrag.push('');
      continue;
    }
    emptyCount = 0;
    if (t.length <= 8 && !t.includes('```') && !t.startsWith('|')) {
      buf.push(t);
    } else {
      flush();
      defrag.push(line);
    }
  }
  flush();

  result = defrag.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
};

module.exports = { cleanText };