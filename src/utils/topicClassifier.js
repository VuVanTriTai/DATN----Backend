// utils/topicClassifier.js
"use strict";

/**
 * Topic Classifier v2 — domain-agnostic
 *
 * Phân loại mỗi chunk vào một trong các topic TỔNG QUÁT dựa trên tín hiệu
 * cấu trúc và ngôn ngữ học — KHÔNG hardcode từ vựng SQL hay bất kỳ domain nào.
 *
 * ⚠️ LƯU Ý QUAN TRỌNG về \b với tiếng Việt:
 * JS \b chỉ nhận diện ASCII word boundary [a-zA-Z0-9_].
 * Ký tự tiếng Việt có dấu (à, ì, ọ, ư...) là \W trong JS regex.
 * Do đó KHÔNG dùng \b bao quanh từ tiếng Việt thuần có dấu.
 * Thay bằng: /(^|\s)từ(\s|$|[.,;:?!])/ hoặc /(?<!\w)từ(?!\w)/
 *
 * Topic taxonomy (mở rộng được):
 *   definition      — định nghĩa, giải thích khái niệm ("là gì", "được gọi là")
 *   principle       — nguyên lý, quy tắc, định luật, định lý
 *   process         — quy trình, bước thực hiện, thuật toán, phương pháp
 *   comparison      — so sánh, đối chiếu giữa các khái niệm
 *   example         — ví dụ minh họa, case study, bài tập mẫu
 *   formula         — công thức, biểu thức toán, mã nguồn, pseudo-code
 *   classification  — phân loại, liệt kê các nhóm/loại/dạng
 *   history         — bối cảnh lịch sử, nguồn gốc, phát triển
 *   application     — ứng dụng thực tế, kịch bản dùng, lợi ích
 *   summary         — tóm tắt, kết luận, ghi nhớ
 *   general         — fallback khi không khớp rule nào
 *
 * Strategy: score-based — đếm số lần khớp pattern; topic có score cao nhất thắng.
 */

// ─────────────────────────────────────────────
// HELPERS: wrap Vietnamese patterns safely
// ─────────────────────────────────────────────

/**
 * Tạo regex match từ tiếng Việt có dấu không dùng \b.
 * Dùng lookbehind/lookahead: không đứng sau ký tự word ASCII.
 */
const vn = (pattern) => new RegExp(`(?<![a-zA-Z0-9_])(?:${pattern})(?![a-zA-Z0-9_])`, "i");

// ─────────────────────────────────────────────
// RULE DEFINITIONS
// ─────────────────────────────────────────────

const TOPIC_RULES = [
  // ── Formula / Code ───────────────────────────
  {
    topic: "formula",
    patterns: [
      /^```/m,
      /[=+\-*/^√∑∏≤≥≈∫∂]/,
      /\b[A-Za-z_]\w*\s*\(/,                          // function call
      /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|FROM|WHERE)\b/i,
      /\b(def |class |import |function |return )/,
      /\b(int|float|double|string|bool|void)\s+\w/i,
      /→|←|⟶|⟵|∴|∵/,
    ],
  },

  // ── Definition ───────────────────────────────
  {
    topic: "definition",
    patterns: [
      // "là gì" / "là một" — dùng lookahead/behind thay \b
      /(?<![a-zA-Z0-9_])l[aà]\s+g[iì](?![a-zA-Z0-9_])/i,     // "là gì" / "la gi"
      /(?<![a-zA-Z0-9_])l[aà]\s+(m[oộ]t|t[aậ]p|kh[aá]i)/i,  // "là một", "là tập"
      /(?<![a-zA-Z0-9_])[dđ][iị]nh\s+ngh[iĩ]a(?![a-zA-Z0-9_])/i, // "định nghĩa"
      /(?<![a-zA-Z0-9_])kh[aá]i\s+ni[eệ]m(?![a-zA-Z0-9_])/i, // "khái niệm"
      /(?<![a-zA-Z0-9_])thu[aậ]t\s+ng[uữ](?![a-zA-Z0-9_])/i, // "thuật ngữ"
      /(?<![a-zA-Z0-9_])[dđ]u[oợ]c\s+(g[oọ]i\s+l[aà]|hi[eể]u\s+l[aà])/i,
      /\bis\s+(a|an|the|defined\s+as|known\s+as|called)\b/i,
      /\b(definition|denoted|refers to|means that)\b/i,
      /\b(what\s+is|what's)\b/i,
    ],
  },

  // ── Principle / Law / Rule ───────────────────
  {
    topic: "principle",
    patterns: [
      /(?<![a-zA-Z0-9_])nguy[eê]n\s*(t[aắ]c|l[yý])(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])[dđ][iị]nh\s*(lu[aậ]t|l[yý])(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])quy\s*(t[aắ]c|lu[aậ]t)(?![a-zA-Z0-9_])/i,
      /\b(principle|law|theorem|axiom|lemma|corollary|postulate|rule)\b/i,
      /\b(must|shall|should|always|never)\b/i,
    ],
  },

  // ── Process / Step / Method ────────────────────────────────
  {
    topic: "process",
    patterns: [
      // ✔ FIX: bước = b(42)+ư(1b0)+ớ(1edb)+c(63) — dùng ớ không phải ờ
      /(?<![a-zA-Z0-9_])b[ư][ớ]c(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])quy\s*tr[iì]nh(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])thu[aật]\s*to[aá]n(?![a-zA-Z0-9_])/i,
      // Pattern an toàn cho ÓBước N:' / 'Giai đoạn N:' (không phụ thuộc charset)
      /[A-Za-zÀ-ỹ]+(?:\s+[A-Za-zÀ-ỹ]+)*\s+\d+\s*[:.]/m,
      /\b(step|phase|stage|procedure|algorithm|workflow|process|method)\b/i,
      /^\s*\d+[.)]\s+[A-ZÀ-ỹa-zà-ỹ]/m,
      /(?<![a-zA-Z0-9_])([dđ][aầ]u\s+ti[eê]n|ti[eế]p\s+theo|sau\s+[dđ][oó])(?![a-zA-Z0-9_])/i,
      /\b(first|then|next|finally|after that|subsequently)\b/i,
    ],
  },

  // ── Classification / Taxonomy ────────────────
  {
    topic: "classification",
    patterns: [
      /(?<![a-zA-Z0-9_])(\d+\s+)?(lo[aạ]i|d[aạ]ng|nh[oó]m|ki[eể]u|m[uứ]c\s*[dđ][oộ])(?![a-zA-Z0-9_])/i,
      /\b(type|kind|category|class|group|form|mode|level)\b/i,
      /(?<![a-zA-Z0-9_])(bao\s+g[oồ]m|chi[aề]\s+th[aà]nh|ph[aâ]n\s+lo[aạ]i)(?![a-zA-Z0-9_])/i,
      /\b(includes?|consists?\s+of|divided\s+into|classified\s+as|categories)\b/i,
    ],
  },

  // ── Comparison ───────────────────────────────
  {
    topic: "comparison",
    patterns: [
      /(?<![a-zA-Z0-9_])so\s+s[aá]nh(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(kh[aá]c\s+v[oớ]i|t[uư][oơ]ng\s+t[uự]|ng[uưư][oợ]c\s+l[aạ]i)(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])([uư]u\s+[dđ]i[eể]m|nh[uượ][oợ]c\s+[dđ]i[eể]m)(?![a-zA-Z0-9_])/i,
      /\b(compare|contrast|similar\s+to|unlike|whereas|however|on the other hand)\b/i,
      /\b(advantage|disadvantage|pros|cons|strength|weakness)\b/i,
    ],
  },

  // ── Example / Case Study ─────────────────────
  {
    topic: "example",
    patterns: [
      // Dùng pattern không có \b để match "Ví dụ" có dấu tiếng Việt
      /[Vv][íi]\s*d[ụu]/,                                       // "Ví dụ" / "vi du"
      /^[Vv]í\s*dụ\s*[:]/m,                                     // "Ví dụ:" đầu dòng
      /(?<![a-zA-Z0-9_])ch[aă]ng\s*h[aạ]n(?![a-zA-Z0-9_])/i,  // "chẳng hạn"
      /(?<![a-zA-Z0-9_])minh\s*h[oọ]a(?![a-zA-Z0-9_])/i,      // "minh họa"
      /(?<![a-zA-Z0-9_])gi[aả]\s*(s[uử]|[dđ][iị]nh)(?![a-zA-Z0-9_])/i, // "giả sử/định"
      /\b(example|for\s+instance|such\s+as|e\.g\.|illustration|case\s+study|scenario)\b/i,
      /\b(suppose|assume|consider|let's\s+say|imagine)\b/i,
      /^Example\s*[:]/im,
    ],
  },

  // ── Application / Use Case ───────────────────
  {
    topic: "application",
    patterns: [
      /(?<![a-zA-Z0-9_])[uư]ng\s*d[uụ]ng(?![a-zA-Z0-9_])/i,  // "ứng dụng"
      /(?<![a-zA-Z0-9_])[aá]p\s*d[uụ]ng(?![a-zA-Z0-9_])/i,   // "áp dụng"
      /\b(application|used\s+in|applied\s+to|use\s+case|benefit|practical|real-world)\b/i,
    ],
  },

  // ── History / Context ────────────────────────
  {
    topic: "history",
    patterns: [
      /(?<![a-zA-Z0-9_])l[iị]ch\s*s[uử](?![a-zA-Z0-9_])/i,   // "lịch sử"
      /(?<![a-zA-Z0-9_])ngu[oồ]n\s*g[oố]c(?![a-zA-Z0-9_])/i, // "nguồn gốc"
      /(?<![a-zA-Z0-9_])b[oố]i\s*c[aả]nh(?![a-zA-Z0-9_])/i,  // "bối cảnh"
      /\b(history|historical|developed\s+by|introduced\s+in|origin|background)\b/i,
      /\b(earlier|originally|historically|century|decade)\b/i,
      /\b(năm|year)\s+\d{4}\b/i,
    ],
  },

  // ── Summary / Conclusion ─────────────────────
  {
    topic: "summary",
    patterns: [
      /(?<![a-zA-Z0-9_])t[oó]m\s*t[aắ]t(?![a-zA-Z0-9_])/i,   // "tóm tắt"
      /(?<![a-zA-Z0-9_])k[eế]t\s*lu[aậ]n(?![a-zA-Z0-9_])/i,  // "kết luận"
      /(?<![a-zA-Z0-9_])t[oó]m\s*l[aạ]i(?![a-zA-Z0-9_])/i,   // "tóm lại"
      /\b(summary|conclusion|key\s+points|takeaway|recap|in\s+summary|to\s+sum\s+up)\b/i,
    ],
  },
];

// ─────────────────────────────────────────────
// SCORE-BASED CLASSIFIER
// ─────────────────────────────────────────────

/**
 * Classify a chunk into a single topic.
 * Tallies match counts per topic, returns the winner.
 * Falls back to "general" when no rule fires.
 */
const classifyTopic = (content = "", section = "") => {
  const combined = `${section}\n${content}`;
  const scores = {};

  for (const rule of TOPIC_RULES) {
    let count = 0;
    for (const pat of rule.patterns) {
      const matches = combined.match(new RegExp(pat.source, (pat.flags || "") + "g"));
      if (matches) count += matches.length;
    }
    if (count > 0) scores[rule.topic] = (scores[rule.topic] || 0) + count;
  }

  if (Object.keys(scores).length === 0) return "general";
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
};

/**
 * Classify an array of chunks. Mutates each chunk in-place, adds `chunk.topic`.
 */
const classifyChunks = (chunks = []) => {
  const topicCounts = {};
  for (const chunk of chunks) {
    chunk.topic = classifyTopic(chunk.content, chunk.section);
    topicCounts[chunk.topic] = (topicCounts[chunk.topic] || 0) + 1;
  }
  console.log("[TopicClassifier] Distribution:", topicCounts);
  return chunks;
};

/**
 * Given a plain-text question, infer which topics are relevant for RAG filtering.
 * QUAN TRỌNG: definition/example check TRƯỚC principle/classification để tránh bị chen mất.
 */
const inferTopicsFromQuestion = (question = "") => {
  const q = question;
  const matched = [];

  const tryAdd = (topic, patterns) => {
    if (matched.includes(topic)) return;
    for (const pat of patterns) {
      if (pat.test(q)) { matched.push(topic); return; }
    }
  };

  // definition TRƯỚC principle — "định nghĩa là gì" phải → definition, không phải principle
  tryAdd("definition", [
    /(?<![a-zA-Z0-9_])l[aà]\s+g[iì](?![a-zA-Z0-9_])/i,           // "là gì"
    /(?<![a-zA-Z0-9_])[dđ][iị]nh\s+ngh[iĩ]a(?![a-zA-Z0-9_])/i,  // "định nghĩa"
    /(?<![a-zA-Z0-9_])kh[aá]i\s+ni[eệ]m(?![a-zA-Z0-9_])/i,       // "khái niệm"
    /\b(what\s+is|what's|definition\s+of|define)\b/i,
  ]);
  // example TRƯỚC classification — "Ví dụ trường hợp..." phải → example
  tryAdd("example", [
    /[Vv][íi]\s*d[ụu]/,                                            // "Ví dụ" / "vi du"
    /(?<![a-zA-Z0-9_])ch[aă]ng\s*h[aạ]n(?![a-zA-Z0-9_])/i,
    /(?<![a-zA-Z0-9_])minh\s*h[oọ]a(?![a-zA-Z0-9_])/i,
    /\b(example|for\s+instance|such\s+as|e\.g\.|case\s+study)\b/i,
  ]);
  tryAdd("formula",        [/```|\b(c[oô]ng\s+th[uứ]c|code|h[aà]m|function|sql|query|to[aá]n)\b/i]);
  tryAdd("principle",      [
    /(?<![a-zA-Z0-9_])nguy[eê]n\s*(t[aắ]c|l[yý])(?![a-zA-Z0-9_])/i,
    /\b(principle|law|theorem|axiom|rule)\b/i,
  ]);
  tryAdd("process",        [
    /(?<![a-zA-Z0-9_])b[uướ][oờ]c(?![a-zA-Z0-9_])/i,
    /(?<![a-zA-Z0-9_])quy\s*tr[iì]nh(?![a-zA-Z0-9_])/i,
    /\b(how\s+to|step|process|algorithm)\b/i,
  ]);
  tryAdd("classification", [
    /(?<![a-zA-Z0-9_])ph[aâ]n\s+lo[aạ]i(?![a-zA-Z0-9_])/i,
    /(?<![a-zA-Z0-9_])lo[aạ]i\s+n[aà]o(?![a-zA-Z0-9_])/i,
    /\b(type|category|classify)\b/i,
  ]);
  tryAdd("comparison",     [
    /(?<![a-zA-Z0-9_])so\s+s[aá]nh(?![a-zA-Z0-9_])/i,
    /\b(compare|difference|similar)\b/i,
  ]);
  tryAdd("application",    [
    /(?<![a-zA-Z0-9_])[uư]ng\s+d[uụ]ng(?![a-zA-Z0-9_])/i,
    /\b(use\s+case|application|practical)\b/i,
  ]);
  tryAdd("history",        [
    /(?<![a-zA-Z0-9_])l[iị]ch\s+s[uử](?![a-zA-Z0-9_])/i,
    /\b(history|origin|background)\b/i,
  ]);
  tryAdd("summary",        [
    /(?<![a-zA-Z0-9_])t[oó]m\s+t[aắ]t(?![a-zA-Z0-9_])/i,
    /\b(summary|conclusion|recap)\b/i,
  ]);

  return matched;
};

module.exports = { classifyTopic, classifyChunks, inferTopicsFromQuestion };
