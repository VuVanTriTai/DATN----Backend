"use strict";

// ─────────────────────────────────────────────────────────────────
// utils/chunkText.js — SEMANTIC HEADING CHUNKER
//
// Strategy:
//   1. Split document at heading boundaries (## / ###)
//   2. Each section = 1 chunk by default
//   3. If a section is too long, split at natural break points
//      (blank line, end-of-list, end-of-code-block) — never mid-sentence,
//      never mid-table, never mid-code-block, never mid-list
//   4. Light overlap: carry the section heading + last paragraph into next
//      chunk so RAG context is maintained
// ─────────────────────────────────────────────────────────────────

const MAX_CHUNK_WORDS  = 350;   // hard ceiling before we sub-split
const MIN_CHUNK_WORDS  = 40;    // discard noise chunks below this
const OVERLAP_HEADING  = true;  // prepend section heading to every sub-chunk

// ─────────────────────────────────────────────
// PDF / DOC: numbered heading split across two lines ("1.1" + "Tiêu đề")
// ─────────────────────────────────────────────

const isNumberOnlyHeadingLine = (s) => /^\d+(\.\d+)+\s*$/.test(String(s || "").trim());

const mergeNextLineUnsafe = (nextLine) => {
  const t = String(nextLine || "").trim();
  if (!t) return true;
  if (/^```|^\|/.test(t)) return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^[-*+]\s/.test(t)) return true;
  if (/^\d+\.\s/.test(t)) return true;
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DECLARE|WITH|FROM|WHERE|USE|GO)\b/i.test(t)) {
    return true;
  }
  return false;
};

const looksLikeShortTitleLine = (nextLine) => {
  const t = String(nextLine || "").trim();
  if (t.length < 2 || t.length > 120) return false;
  if (!/^[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) return false;
  return true;
};

/**
 * Ghép dòng chỉ có số mục (vd 1.1) với dòng tiếp theo là tiêu đề chữ,
 * để chunkText / outline nhận diện được heading một dòng.
 * Idempotent: chạy nhiều lần không đổi kết quả sau lần đầu.
 */
const mergeBrokenNumberedHeadings = (text) => {
  if (!text || typeof text !== "string") return text || "";
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (
      i + 1 < lines.length &&
      isNumberOnlyHeadingLine(trimmed) &&
      !mergeNextLineUnsafe(lines[i + 1]) &&
      looksLikeShortTitleLine(lines[i + 1])
    ) {
      const title = lines[i + 1].trim();
      out.push(`${trimmed} ${title}`.replace(/\s+/g, " ").trim());
      i += 1;
      continue;
    }
    out.push(raw);
  }
  return out.join("\n");
};

// ─────────────────────────────────────────────
// HEADING DETECTION
// ─────────────────────────────────────────────

/**
 * Returns heading level (1-6) if line is a Markdown ATX heading, else 0.
 * Only treats h1-h4 as section boundaries for chunking.
 */
const headingLevel = (line) => {
  // Markdown ATX heading: ## Tiêu đề
  const md = line.match(/^(#{1,4})\s+\S/);
  if (md) return md[1].length;

  const t = line.trim();

  // Numbered section: 1. / 1.1 / 1.1.2 / 2.3.4 Tiêu đề
  if (/^\d+(\.\d+)*\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) {
    const dots = (t.match(/\./g) || []).length;
    return Math.min(dots + 1, 4); // 1. → h1, 1.1 → h2, 1.1.1 → h3
  }

  // Chương / Phần / Chapter / Section
  if (/^(chương|chapter|phần|section)\s+\d/i.test(t)) return 1;

  // ALL CAPS heading (không phải code, độ dài hợp lý)
  if (
    t.length >= 4 && t.length <= 80 &&
    t === t.toUpperCase() &&
    /[A-ZÀ-Ỹ]/.test(t) &&
    !/[{}()\[\];=]/.test(t)
  ) return 2;

  return 0;
};

// ─────────────────────────────────────────────
// SECTION SPLITTER (called when a section is too long)
// ─────────────────────────────────────────────

/**
 * Classify a line for safe-split-point detection.
 */
const lineKind = (line) => {
  if (!line.trim())                       return "blank";
  if (/^\s*```/.test(line))               return "fence";   // code fence
  if (/^\s*\|/.test(line))               return "table";
  if (/^#{1,6}\s/.test(line.trim()))     return "heading";
  if (/^[\s]*[-*+]\s|^\s*\d+\.\s/.test(line)) return "list";
  return "text";
};

/**
 * Split lines of a section into sub-chunks.
 * Never cuts inside a table block, code fence block, or bullet list.
 * Cuts only at blank lines when accumulated words >= MAX_CHUNK_WORDS * 0.7.
 */
const splitSection = (sectionHeading, lines) => {
  const results   = [];
  let buffer      = sectionHeading ? [sectionHeading, ""] : [];
  let words       = 0;
  let inFence     = false;
  let inTable     = false;

  const flushBuffer = () => {
    const content = buffer.join("\n").trim();
    const wc = content.split(/\s+/).filter(Boolean).length;
    if (wc >= MIN_CHUNK_WORDS) results.push({ content, wordCount: wc });

    // Overlap: keep heading for next sub-chunk
    buffer = sectionHeading && OVERLAP_HEADING ? [sectionHeading, ""] : [];
    words  = buffer.join(" ").split(/\s+/).filter(Boolean).length;
  };

  for (const line of lines) {
    const kind = lineKind(line);

    // Track fenced code blocks — never split inside
    if (kind === "fence") inFence = !inFence;

    // Track table rows — a blank line ends the table
    if (kind === "table")  inTable = true;
    if (kind === "blank")  inTable = false;

    const lineWords = line.split(/\s+/).filter(Boolean).length;

    // Only consider splitting at blank lines, and only when we're not
    // inside a protected block
    if (
      kind === "blank"      &&
      !inFence              &&
      !inTable              &&
      words >= MAX_CHUNK_WORDS * 0.7
    ) {
      flushBuffer();
      continue; // don't add the blank line itself
    }

    buffer.push(line);
    words += lineWords;
  }

  // Flush remainder
  const content = buffer.join("\n").trim();
  const wc = content.split(/\s+/).filter(Boolean).length;
  if (wc >= MIN_CHUNK_WORDS) results.push({ content, wordCount: wc });

  return results;
};

// ─────────────────────────────────────────────
// MAIN CHUNKER
// ─────────────────────────────────────────────

/**
 * Chunk a Markdown (or plain-text) document into semantic sections.
 *
 * Returns an array of:
 *   { index, section, content, wordCount }
 *
 * - `section`   — the nearest heading text (for metadata / display)
 * - `content`   — the actual chunk text (heading + body)
 * - `wordCount` — word count of content
 */
const chunkText = (text) => {
  if (!text || typeof text !== "string") return [];

  text = mergeBrokenNumberedHeadings(text);

  const lines   = text.split("\n");
  const chunks  = [];

  // ── Pass 1: split into sections at heading boundaries ──
  const sections = []; // { heading: string|null, lines: string[] }
  let current = { heading: null, lines: [] };

  for (const line of lines) {
    const level = headingLevel(line);
    if (level > 0) {
      // Save previous section if it has content
      if (current.lines.some(l => l.trim())) sections.push(current);
      current = { heading: line.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some(l => l.trim()) || current.heading) {
    sections.push(current);
  }

  // ── Pass 2: each section → one or more chunks ──
  let chunkIndex = 0;

  for (const section of sections) {
    const headerLine = section.heading || null;
    const bodyLines  = section.lines;

    // Word count of section body
    const bodyWords = bodyLines
      .join(" ")
      .split(/\s+/)
      .filter(Boolean).length;

    const headerWords = headerLine
      ? headerLine.split(/\s+/).filter(Boolean).length
      : 0;

    const totalWords = bodyWords + headerWords;

    if (totalWords < MIN_CHUNK_WORDS) continue; // skip near-empty sections

    if (totalWords <= MAX_CHUNK_WORDS) {
      // Section fits in one chunk — keep it whole
      const content = headerLine
        ? [headerLine, ...bodyLines].join("\n").trim()
        : bodyLines.join("\n").trim();

      const wc = content.split(/\s+/).filter(Boolean).length;
      if (wc >= MIN_CHUNK_WORDS) {
        chunks.push({
          index    : chunkIndex++,
          section  : headerLine || "",
          content,
          wordCount: wc,
        });
      }
    } else {
      // Section is too long — sub-split at safe break points
      const subChunks = splitSection(headerLine, bodyLines);
      for (const sc of subChunks) {
        chunks.push({
          index    : chunkIndex++,
          section  : headerLine || "",
          content  : sc.content,
          wordCount: sc.wordCount,
        });
      }
    }
  }

  console.log(
    `[chunkText] ${chunks.length} chunks from ${lines.length} lines ` +
    `(${sections.length} sections)`
  );
  return chunks;
};

module.exports = { chunkText, mergeBrokenNumberedHeadings };