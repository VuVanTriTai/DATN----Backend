"use strict";

/**
 * Concept Extractor v2 — domain-agnostic
 *
 * Trích xuất danh sách "khái niệm đã dạy" từ nội dung bài học MỌI CHỦ ĐỀ
 * (không chỉ SQL / code).
 *
 * Strategy:
 *  1. Heading scan  — tiêu đề ## / ### thường là tên khái niệm chính
 *  2. Bold terms    — **Thuật ngữ** hay *Khái niệm* → marker đánh dấu định nghĩa
 *  3. Bullet labels — "Nguyên tắc X:", "Quy tắc Y:", "Định lý Z:" đầu bullet
 *  4. Numbered terms— "1. Khái niệm A", "2.1 Phương pháp B"
 *
 * Tất cả đều agnostic với chủ đề — hoạt động với SQL, y khoa, luật, kinh tế,
 * lịch sử, vật lý, văn học, v.v.
 */

// ─────────────────────────────────────────────
// GENERIC STOP HEADINGS (bỏ qua heading cấu trúc, không phải tên khái niệm)
// ─────────────────────────────────────────────
const GENERIC_HEADING_RE = /^(kết\s*luận|tóm\s*tắt|ví\s*dụ(\s*thực\s*tế)?|tổng\s*kết|giới\s*thiệu|mục\s*tiêu|overview|summary|introduction|conclusion|examples?|notes?|lưu\s*ý|bài\s*tập|exercises?|quiz|câu\s*hỏi|bài\s*học|nội\s*dung|thực\s*hành|practice|reference|tài\s*liệu|phụ\s*lục|appendix)/i;

// Heading CHỨA ít nhất 1 từ có nghĩa học thuật (không phải chỉ particle/stop word)
const ACADEMIC_WORD_RE = /[A-ZÀ-ỹa-zà-ỹ]{3,}/;

// Stop words ngắn — không tính là khái niệm đứng một mình
const STOP_WORDS = new Set([
  "và", "với", "trong", "của", "cho", "các", "một", "được", "này",
  "khi", "thì", "không", "phải", "như", "theo", "là", "có", "từ", "về", "để",
  "the", "and", "for", "with", "using", "about", "how", "to", "in", "of", "a", "an",
  "that", "this", "from", "are", "was", "were", "will", "its", "it",
]);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const normalizeConcept = (raw) =>
  (raw || "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/^\d+(\.\d+)*[.\s]+/, "")   // strip leading "1.2 " or "1."
    .replace(/[:#()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** True nếu chuỗi đủ dài và không phải stop word / quá ngắn */
const isValidConcept = (s) => {
  if (!s || s.length < 3 || s.length > 80) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 8) return false;   // quá dài → không phải tên khái niệm
  if (words.every(w => STOP_WORDS.has(w.toLowerCase()))) return false;
  return ACADEMIC_WORD_RE.test(s);
};

// ─────────────────────────────────────────────
// 1. HEADING EXTRACTOR
// Lấy nội dung ##, ### làm tên khái niệm — chỉ giữ heading có ý nghĩa học thuật
// ─────────────────────────────────────────────
const extractFromHeadings = (text) => {
  const concepts = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,4}\s+(.+)/);
    if (!m) continue;

    const heading = normalizeConcept(m[1]);
    if (!heading) continue;
    if (GENERIC_HEADING_RE.test(heading)) continue;
    if (isValidConcept(heading)) {
      concepts.push(heading);
    }
  }
  return concepts;
};

// ─────────────────────────────────────────────
// 2. BOLD TERM EXTRACTOR
// **Thuật ngữ** hoặc *Khái niệm* thường là key terms được định nghĩa
// ─────────────────────────────────────────────
const extractFromBoldTerms = (text) => {
  const concepts = [];
  // **Term** hoặc __Term__
  const boldRe = /\*\*([^*\n]{3,60})\*\*|__([^_\n]{3,60})__/g;
  let m;
  while ((m = boldRe.exec(text)) !== null) {
    const term = normalizeConcept(m[1] || m[2]);
    if (isValidConcept(term)) concepts.push(term);
  }
  return concepts;
};

// ─────────────────────────────────────────────
// 3. LABELED BULLET EXTRACTOR
// "- Nguyên tắc X:", "• Quy tắc Y:", "◦ Định lý Z:" trước dấu hai chấm
// ─────────────────────────────────────────────
const extractFromBulletLabels = (text) => {
  const concepts = [];
  // Bullet line bắt đầu bằng - / • / ◦ / * rồi có label: nội dung
  const bulletRe = /^[\s]*[-•◦*]\s+([^:\n]{3,50}):/gm;
  let m;
  while ((m = bulletRe.exec(text)) !== null) {
    const term = normalizeConcept(m[1]);
    if (isValidConcept(term)) concepts.push(term);
  }
  return concepts;
};

// ─────────────────────────────────────────────
// 4. NUMBERED TERM EXTRACTOR
// "1. Khái niệm A", "2.1 Phương pháp B" — chỉ lấy phần text ngắn sau số
// ─────────────────────────────────────────────
const extractFromNumberedItems = (text) => {
  const concepts = [];
  const numRe = /^\s*\d+(\.\d+)*[.)]\s+([A-ZÀ-Ỹa-zà-ỹ][^\n]{2,60})/gm;
  let m;
  while ((m = numRe.exec(text)) !== null) {
    // Lấy text ngắn nhất — chỉ đến dấu câu đầu tiên (không phải câu dài)
    const raw = m[2].split(/[.!?;:]/)[0];
    const term = normalizeConcept(raw);
    if (isValidConcept(term) && term.split(/\s+/).length <= 6) {
      concepts.push(term);
    }
  }
  return concepts;
};

// ─────────────────────────────────────────────
// MAIN EXPORT: extractConcepts
// ─────────────────────────────────────────────

/**
 * Extract a deduplicated list of key concepts taught in a lesson.
 * Works for ANY subject domain (SQL, law, medicine, physics, history...).
 *
 * @param {string} content  - lesson markdown content
 * @param {string} [title]  - lesson title (also scanned)
 * @returns {string[]}      - e.g. ["Nguyên tắc phân quyền", "JOIN bảng", "Định lý Bayes"]
 */
const extractConcepts = (content = "", title = "") => {
  const combined = `${title}\n${content}`;
  const found = new Set();

  const addAll = (list) => {
    for (const item of list) {
      const normalized = item.trim();
      if (normalized) found.add(normalized);
    }
  };

  addAll(extractFromHeadings(combined));
  addAll(extractFromBoldTerms(combined));
  addAll(extractFromBulletLabels(combined));
  // Numbered items có thể noisy — chỉ lấy khi heading không đủ
  if (found.size < 3) {
    addAll(extractFromNumberedItems(combined));
  }

  // Loại bỏ trùng (case-insensitive dedup)
  const seen = new Set();
  const unique = [];
  for (const c of found) {
    const key = c.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  return unique.slice(0, 30); // giới hạn để không làm prompt quá dài
};

/**
 * Merge new concepts into an existing usedConcepts array (dedup).
 *
 * @param {string[]} existing
 * @param {string[]} newConcepts
 * @returns {string[]}
 */
const mergeConcepts = (existing = [], newConcepts = []) => {
  const seen = new Set(existing.map(c => c.toLowerCase()));
  const result = [...existing];
  for (const c of newConcepts) {
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      result.push(c);
    }
  }
  return result;
};

/**
 * Build a short string block to inject into the AI prompt.
 * E.g. "Nguyên tắc phân quyền, Định lý Bayes, JOIN bảng"
 *
 * @param {string[]} usedConcepts
 * @returns {string}
 */
const buildUsedConceptsBlock = (usedConcepts = []) => {
  if (!usedConcepts.length) return "";
  // Gộp lại, giới hạn 25 concept để không vượt prompt limit
  return usedConcepts.slice(0, 25).join(", ");
};

module.exports = { extractConcepts, mergeConcepts, buildUsedConceptsBlock };