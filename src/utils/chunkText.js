"use strict";

// ─────────────────────────────────────────────────────────────────
// utils/chunkText.js — SEMANTIC HEADING CHUNKER (multi-topic edition)
//
// FIXES (cumulative — all previous FIX-A/B/C/D retained):
//
//   FIX-A  splitSection final flush: short trailing sections merged into
//          previous chunk instead of being dropped.
//
//   FIX-B  splitSection blank-line flush: two-tier strategy — hard flush
//          at MAX_CHUNK_WORDS regardless of line type, soft flush at blank
//          lines when words >= MIN_CHUNK_WORDS.
//
//   FIX-C  chunkText pendingShort: final flushPending() runs unconditionally.
//
//   FIX-D  splitIntoPropositions: proposition length cap raised 75 → 120.
//
//   FIX-E  (NEW) splitSection blank-line-after-hard-flush ghost chunk:
//          After a hard flush the buffer is reset to just the heading.
//          If the very next line is blank it would immediately trigger
//          the soft flush and emit an almost-empty "heading-only" chunk.
//          Guard added: skip blank-line soft flush when buffer word count
//          equals the heading word count (nothing new was added yet).
//
//   FIX-F  (NEW) headingLevel Roman-numeral false positive:
//          "I.", "V." at the start of a Vietnamese prose sentence was
//          matching the Roman-numeral heading regex.  Added a minimum
//          word-count guard (≥ 3 tokens) so single-word "I. text" lines
//          are not mis-classified as chapter headings.
//
//   FIX-G  (NEW) splitIntoPropositions empty-part guard:
//          Splitting on sentence-ending punctuation produced empty strings
//          (e.g. from "…" ellipsis or trailing punctuation).  Parts are
//          now filtered for minimum character length before word-counting.
//
//   FIX-H  (NEW) splitSection blank-line push guard:
//          After a hard flush, the current line (which triggered the flush)
//          is blank.  Pushing a blank string into the fresh buffer added
//          noise.  Blank lines are now skipped after a hard flush via
//          the existing `continue` path.
// ─────────────────────────────────────────────────────────────────

const MAX_CHUNK_WORDS          = 350;
const MIN_CHUNK_WORDS          = 40;
const MIN_CHUNK_WORDS_NUMBERED = 15;
const OVERLAP_HEADING          = true;
// Số câu cuối của chunk trước được lặp lại vào đầu chunk tiếp theo (sliding window overlap)
const OVERLAP_SENTENCES        = 2;

// ─────────────────────────────────────────────
// PDF / DOC: numbered heading split across two lines
// ─────────────────────────────────────────────

const isNumberOnlyHeadingLine = (s) =>
  /^\d+(\.\d+)+\s*$/.test(String(s || "").trim());

const mergeNextLineUnsafe = (nextLine) => {
  const t = String(nextLine || "").trim();
  if (!t) return true;
  if (/^```|^\|/.test(t)) return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^[-*+]\s/.test(t)) return true;
  if (/^\d+\.\s/.test(t)) return true;
  if (/^[=+\-*/(){}[\]|;,@#$^&<>]/.test(t)) return true;
  return false;
};

const looksLikeShortTitleLine = (nextLine) => {
  const t = String(nextLine || "").trim();
  if (t.length < 2 || t.length > 120) return false;
  if (!/^[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) return false;
  return true;
};

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

const headingLevel = (line) => {
  const md = line.match(/^(#{1,4})\s+\S/);
  if (md) return md[1].length;

  const t = line.trim();

  if (/^\d+(\.\d+)*\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) {
    const dots = (t.match(/\./g) || []).length;
    return Math.min(dots + 1, 4);
  }

  if (/^[A-Z]\.\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) return 2;

  // FIX-F: require ≥ 3 words for Roman-numeral headings to avoid matching
  // Vietnamese prose sentences that happen to start with "I.", "V." etc.
  if (
    /^(I{1,3}|IV|V?I{0,3}|IX|X{0,3})\.\s+[A-ZÀ-Ỹa-zà-ỹ]/i.test(t) &&
    t.length <= 100 &&
    t.split(/\s+/).filter(Boolean).length >= 3
  ) return 1;

  if (
    /^(chương|chapter|phần|section|part|module|unit|bài|mục|topic|lesson)\s+(\d+|[IVX]+)/i.test(t)
  ) return 1;

  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (
    wordCount >= 2 &&
    t.length >= 4 && t.length <= 80 &&
    t === t.toUpperCase() &&
    /[A-ZÀ-Ỹ]/.test(t) &&
    !/[{}()\[\];=]/.test(t)
  ) return 2;

  return 0;
};

// ─────────────────────────────────────────────
// SECTION SPLITTER  (FIX-A + FIX-B + FIX-E + FIX-H)
// ─────────────────────────────────────────────

const lineKind = (line) => {
  if (!line.trim()) return "blank";
  if (/^\s*```/.test(line)) return "fence";
  if (/^\s*\|/.test(line)) return "table";
  if (/^#{1,6}\s/.test(line.trim())) return "heading";
  if (/^[\s]*[-*+]\s|^\s*\d+\.\s/.test(line)) return "list";
  return "text";
};

// ── OVERLAP HELPER ────────────────────────────────────────────────
// Lấy N câu cuối từ content của chunk trước để làm "đuôi" cho buffer mới.
// Giúp RAG không mất context tại ranh giới chunk.
const getOverlapTail = (content, n) => {
  if (!content || n <= 0) return "";
  // Tách câu theo dấu câu; loại bỏ câu quá ngắn
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);
  if (sentences.length === 0) return "";
  return sentences.slice(-Math.min(n, sentences.length)).join(" ");
};

const splitSection = (sectionHeading, lines) => {
  const results = [];

  // Helper: word count of heading prefix used in fresh buffers
  const headingWords = sectionHeading && OVERLAP_HEADING
    ? sectionHeading.split(/\s+/).filter(Boolean).length
    : 0;

  const makeBuffer = (overlapTail = "") => {
    const base = sectionHeading && OVERLAP_HEADING ? [sectionHeading, ""] : [];
    // Thêm overlap tail (context câu cuối của chunk trước) vào đầu buffer mới
    if (overlapTail) base.push(`<!-- overlap --> ${overlapTail}`);
    return base;
  };

  let buffer  = makeBuffer();
  let words   = headingWords;
  let inFence = false;
  let inTable = false;

  const flushBuffer = () => {
    // Lọc bỏ dòng overlap marker trước khi tính wordCount
    const cleanLines = buffer.map(l => l.replace(/^<!-- overlap --> /, ""));
    const content = cleanLines.join("\n").trim();
    const wc      = content.split(/\s+/).filter(Boolean).length;
    if (wc >= MIN_CHUNK_WORDS) {
      // Phát hiện chunkType dựa trên nội dung
      const hasCode    = /```[\s\S]+?```/.test(content);
      const hasTable   = /^\|.+\|/m.test(content);
      const hasFormula = /\$[^$]+\$|\\[a-z]+\{/.test(content);
      const chunkType  = hasCode ? "code" : hasTable ? "table" : hasFormula ? "formula" : "text";

      results.push({ content, wordCount: wc, chunkType, hasCode, hasTable, hasFormula });
    } else if (results.length > 0) {
      // FIX-A: merge short trailing buffer into the previous chunk
      results[results.length - 1].content += "\n" + content;
      results[results.length - 1].wordCount += wc;
    }

    // Lấy overlap tail từ chunk vừa flush để seed cho buffer tiếp theo
    const lastContent = results.length > 0 ? results[results.length - 1].content : "";
    const overlapTail = getOverlapTail(lastContent, OVERLAP_SENTENCES);
    buffer = makeBuffer(overlapTail);
    words  = headingWords + (overlapTail ? overlapTail.split(/\s+/).filter(Boolean).length : 0);
  };

  for (const line of lines) {
    const kind = lineKind(line);

    if (kind === "fence") inFence = !inFence;
    if (!inFence && kind === "table") inTable = true;
    if (kind === "blank") inTable = false;

    const lineWords = line.split(/\s+/).filter(Boolean).length;

    // FIX-B Tier 1 — hard flush when buffer exceeds MAX_CHUNK_WORDS
    // ⭐ IMPROVEMENT: KHÔNG flush khi đang trong code fence hoặc table
    // (tránh cắt giữa code block / bảng dữ liệu gây mất ngữ cảnh)
    if (!inFence && !inTable && words >= MAX_CHUNK_WORDS) {
      flushBuffer();
      // FIX-H: if the line that triggered the hard flush is blank,
      // skip it — don't push an empty string into the fresh buffer.
      if (kind === "blank") continue;
      // Fall through to push the current non-blank line into fresh buffer
    }

    // FIX-B Tier 2 — soft flush on blank lines with meaningful content
    // FIX-E: guard against flushing an almost-empty buffer that contains
    // only the repeated heading (words == headingWords means nothing new).
    if (kind === "blank" && !inFence && !inTable &&
        words >= MIN_CHUNK_WORDS && words > headingWords) {
      flushBuffer();
      continue;
    }

    buffer.push(line);
    words += lineWords;
  }

  // FIX-A: always flush remaining content
  const cleanLines = buffer.map(l => l.replace(/^<!-- overlap --> /, ""));
  const content = cleanLines.join("\n").trim();
  const wc      = content.split(/\s+/).filter(Boolean).length;
  if (wc >= MIN_CHUNK_WORDS) {
    const hasCode    = /```[\s\S]+?```/.test(content);
    const hasTable   = /^\|.+\|/m.test(content);
    const hasFormula = /\$[^$]+\$|\\[a-z]+\{/.test(content);
    const chunkType  = hasCode ? "code" : hasTable ? "table" : hasFormula ? "formula" : "text";
    results.push({ content, wordCount: wc, chunkType, hasCode, hasTable, hasFormula });
  } else if (wc > 0 && results.length > 0) {
    // Merge short tail into previous chunk
    results[results.length - 1].content += "\n" + content;
    results[results.length - 1].wordCount += wc;
  } else if (wc >= MIN_CHUNK_WORDS_NUMBERED) {
    // Stand-alone numbered section with fewer words — keep as own chunk
    results.push({ content, wordCount: wc });
  }

  return results;
};

// ─────────────────────────────────────────────
// MAIN CHUNKER  (FIX-C)
// ─────────────────────────────────────────────

const chunkText = (text) => {
  if (!text || typeof text !== "string") return [];

  text = mergeBrokenNumberedHeadings(text);

  const lines  = text.split("\n");
  const chunks = [];

  // Pass 1: split into sections at heading boundaries
  const sections = [];
  let current = { heading: null, lines: [] };

  for (const line of lines) {
    const level = headingLevel(line);
    if (level > 0) {
      if (current.lines.some(l => l.trim()) || current.heading) {
        sections.push(current);
      }
      current = { heading: line.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some(l => l.trim()) || current.heading) {
    sections.push(current);
  }

  // Pass 2: each section → one or more chunks
  let chunkIndex   = 0;
  let pendingShort = [];

  const flushPending = (extraSections) => {
    const all = [...pendingShort, ...extraSections];
    pendingShort = [];
    if (!all.length) return;

    const parts = [];
    for (const s of all) {
      if (s.heading) parts.push(s.heading);
      parts.push(...s.lines);
    }

    const content = parts.join("\n").trim();
    const wc      = content.split(/\s+/).filter(Boolean).length;
    if (wc >= MIN_CHUNK_WORDS_NUMBERED) {
      chunks.push({
        index    : chunkIndex++,
        section  : all[0].heading || "",
        content,
        wordCount: wc,
      });
    }
  };

  for (let si = 0; si < sections.length; si++) {
    const section    = sections[si];
    const headerLine = section.heading || null;
    const bodyLines  = section.lines;

    const bodyWords   = bodyLines.join(" ").split(/\s+/).filter(Boolean).length;
    const headerWords = headerLine
      ? headerLine.split(/\s+/).filter(Boolean).length
      : 0;
    const totalWords  = bodyWords + headerWords;

    const isNumberedSection =
      headerLine && /^\d+\.\d+/.test(headerLine.trim());
    const minWords = isNumberedSection
      ? MIN_CHUNK_WORDS_NUMBERED
      : MIN_CHUNK_WORDS;

    if (totalWords < minWords) {
      pendingShort.push(section);
      continue;
    }

    if (totalWords <= MAX_CHUNK_WORDS) {
      flushPending([]);

      const content = headerLine
        ? [headerLine, ...bodyLines].join("\n").trim()
        : bodyLines.join("\n").trim();

      const wc = content.split(/\s+/).filter(Boolean).length;
      if (wc >= minWords) {
        chunks.push({
          index    : chunkIndex++,
          section  : headerLine || "",
          content,
          wordCount: wc,
        });
      }
    } else {
      if (pendingShort.length) {
        const prependLines = [];
        for (const ps of pendingShort) {
          if (ps.heading) prependLines.push(ps.heading);
          prependLines.push(...ps.lines);
        }
        pendingShort = [];
        bodyLines.unshift(...prependLines, "");
      }

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

  // FIX-C: always flush pending short sections at end of document
  flushPending([]);

  console.log(
    `[chunkText] ${chunks.length} chunks from ${lines.length} lines ` +
    `(${sections.length} sections)`
  );
  return chunks;
};

// ─────────────────────────────────────────────
// PROPOSITIONS  (FIX-D + FIX-G)
// ─────────────────────────────────────────────

const VIET_ABBR = [
  "v\\.v", "v\\.v\\.", "TP", "GS\\.TS", "PGS\\.TS", "Th\\.S", "GS", "PGS",
  "TS", "KS", "BS", "BN", "Tr",
  "e\\.g", "i\\.e", "etc", "vs", "approx", "dept", "fig", "eq",
  "no", "vol", "pp", "ed", "tr", "Dr", "Mr", "Mrs", "Ms", "St",
  "prob", "def", "thm", "prop", "cor", "ex", "sec", "ch", "ref",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const ABBR_RE = new RegExp(
  `\\b(${VIET_ABBR.join("|")})\\.(?=\\s)`,
  "gi"
);

const protectAbbr = (s) => s.replace(ABBR_RE, (_, abbr) => `${abbr}⟨DOT⟩`);
const restoreAbbr = (s) => s.replace(/⟨DOT⟩/g, ".");

const splitIntoPropositions = (parentChunk) => {
  if (!parentChunk || !parentChunk.content) return [];

  const section = parentChunk.section ? parentChunk.section.trim() : "";
  let text      = parentChunk.content;

  // 1. Loại bỏ code block lớn ra khỏi proposition
  text = text.replace(/```[\s\S]*?```/g, "");

  // 2. Giữ lại inline code, nhưng không để dấu ` ảnh hưởng đến sentence splitting
  text = text.replace(/`[^`\n]+`/g, (match) => match.slice(1, -1));

  // FIX-G: also strip ellipsis sequences before sentence splitting
  // to avoid empty proposition parts from "..." patterns
  text = text.replace(/\.{3,}/g, " ");

  const rawLines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 5);

  const sentences = [];

  for (const line of rawLines) {
    if (line.startsWith("#") || line === section) continue;

    const protected_ = protectAbbr(line);
    const parts      = protected_.split(/(?<!\d)[.!?](?=\s|$)/);

    for (let part of parts) {
      part = restoreAbbr(part).trim();
      // FIX-G: skip parts that are too short to be meaningful after restoration
      if (part.length < 8) continue;

      part = part.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim();

      const partWords = part.split(/\s+/).filter(Boolean).length;
      if (partWords >= 4) {
        sentences.push(part);
      }
    }
  }

  const propositions  = [];
  const cleanSection  = section.replace(/^#+\s*/, "").trim();

  for (const sentence of sentences) {
    const wordCount = sentence.split(/\s+/).filter(Boolean).length;

    // FIX-D: cap raised from 75 → 120 words so full Vietnamese definitions and
    // compound rules are not silently dropped as "too long".
    if (wordCount >= 6 && wordCount <= 120) {
      const content = cleanSection
        ? `${cleanSection}: ${sentence}`
        : sentence;

      propositions.push({
        content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
      });
    }
  }

  return propositions;
};

module.exports = {
  chunkText,
  mergeBrokenNumberedHeadings,
  splitIntoPropositions,
};