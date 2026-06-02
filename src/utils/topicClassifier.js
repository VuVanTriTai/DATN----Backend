// utils/topicClassifier.js
"use strict";

/**
 * Topic Classifier for SQL/Database document chunks.
 *
 * Classifies each chunk into ONE of the following canonical topics
 * so that RAG retrieval can be filtered by topic instead of pulling
 * in unrelated content (e.g. stored procedures into a date-function lesson).
 *
 * Topic taxonomy (add more as needed):
 *   date_function        — DATEADD, DATEDIFF, GETDATE, FORMAT, YEAR/MONTH/DAY…
 *   string_function      — LEN, SUBSTRING, CHARINDEX, REPLACE, UPPER/LOWER…
 *   math_function        — ABS, ROUND, CEILING, FLOOR, POWER, SQRT…
 *   aggregate_function   — SUM, AVG, COUNT, MIN, MAX, GROUP BY, HAVING…
 *   conversion_function  — CAST, CONVERT, TRY_CAST, TRY_CONVERT, PARSE…
 *   window_function      — ROW_NUMBER, RANK, DENSE_RANK, NTILE, LEAD, LAG, OVER…
 *   join                 — INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL JOIN, CROSS JOIN…
 *   subquery             — subquery, CTE, WITH …AS, EXISTS, IN (subquery)…
 *   stored_procedure     — CREATE PROCEDURE, EXEC, sp_, procedure body…
 *   trigger              — CREATE TRIGGER, AFTER/BEFORE INSERT/UPDATE/DELETE…
 *   transaction          — BEGIN TRAN, COMMIT, ROLLBACK, SAVEPOINT…
 *   temp_table           — #temp, ##global_temp, table variable, @table…
 *   control_flow         — IF/ELSE, WHILE, CASE, BREAK, CONTINUE, GOTO, RETURN…
 *   index                — CREATE INDEX, CLUSTERED, NONCLUSTERED, INCLUDE…
 *   ddl                  — CREATE TABLE, ALTER TABLE, DROP TABLE, TRUNCATE…
 *   dml                  — INSERT, UPDATE, DELETE, MERGE, UPSERT…
 *   view                 — CREATE VIEW, ALTER VIEW, DROP VIEW…
 *   cursor               — DECLARE CURSOR, OPEN, FETCH, CLOSE…
 *   error_handling       — TRY/CATCH, THROW, RAISERROR, @@ERROR…
 *   general              — fallback when no specific topic matches
 */

// ─────────────────────────────────────────────
// RULE DEFINITIONS (order = priority)
// ─────────────────────────────────────────────

const TOPIC_RULES = [
  // ── Stored Procedure ─────────────────────
  {
    topic: "stored_procedure",
    patterns: [
      /\bCREATE\s+(OR\s+REPLACE\s+)?PROC(EDURE)?\b/i,
      /\bEXEC(UTE)?\s+\w+/i,
      /\bSP_\w+/i,
      /\bPROC(EDURE)?\s+\w+/i,
      /\b@\w+\s+AS\s+\w+/i,           // parameter declarations
    ],
  },

  // ── Trigger ──────────────────────────────
  {
    topic: "trigger",
    patterns: [
      /\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i,
      /\bAFTER\s+(INSERT|UPDATE|DELETE)\b/i,
      /\bINSTEAD\s+OF\b/i,
      /\bFOR\s+(INSERT|UPDATE|DELETE)\b/i,
    ],
  },

  // ── Control Flow ─────────────────────────
  {
    topic: "control_flow",
    patterns: [
      /\bIF\s+EXISTS\b/i,
      /\bIF\s*\(/i,
      /\bELSE\s+(IF|BEGIN)\b/i,
      /\bWHILE\s*\(/i,
      /\bBEGIN\s*\n/i,
      /\bCASE\s+WHEN\b/i,
      /\bBREAK\b|\bCONTINUE\b|\bGOTO\b|\bRETURN\b/i,
    ],
  },

  // ── Temp Table / Table Variable ──────────
  {
    topic: "temp_table",
    patterns: [
      /\bCREATE\s+TABLE\s+#\w+/i,
      /\bINTO\s+#\w+/i,
      /\b##\w+/,                        // global temp table
      /\bDECLARE\s+@\w+\s+TABLE\b/i,   // table variable
      /\bSELECT\s+.*\s+INTO\s+#/i,
    ],
  },

  // ── Transaction ──────────────────────────
  {
    topic: "transaction",
    patterns: [
      /\bBEGIN\s+TRAN(SACTION)?\b/i,
      /\bCOMMIT\s+(TRAN(SACTION)?)?\b/i,
      /\bROLLBACK\s+(TRAN(SACTION)?)?\b/i,
      /\bSAVEPOINT\b/i,
      /\b@@TRANCOUNT\b/i,
    ],
  },

  // ── Error Handling ───────────────────────
  {
    topic: "error_handling",
    patterns: [
      /\bBEGIN\s+TRY\b/i,
      /\bBEGIN\s+CATCH\b/i,
      /\bTHROW\b|\bRAISERROR\b/i,
      /\b@@ERROR\b/i,
      /\bERROR_MESSAGE\s*\(\)/i,
    ],
  },

  // ── Cursor ───────────────────────────────
  {
    topic: "cursor",
    patterns: [
      /\bDECLARE\s+\w+\s+CURSOR\b/i,
      /\bOPEN\s+\w+\b/i,
      /\bFETCH\s+(NEXT|PRIOR|FIRST|LAST)\b/i,
      /\bCLOSE\s+\w+\b/i,
      /\bDEALLOCATE\b/i,
    ],
  },

  // ── Window Function ──────────────────────
  {
    topic: "window_function",
    patterns: [
      /\bROW_NUMBER\s*\(\)/i,
      /\bRANK\s*\(\)/i,
      /\bDENSE_RANK\s*\(\)/i,
      /\bNTILE\s*\(/i,
      /\bLEAD\s*\(|\bLAG\s*\(/i,
      /\bFIRST_VALUE\s*\(|\bLAST_VALUE\s*\(/i,
      /\bOVER\s*\(\s*PARTITION\b/i,
    ],
  },

  // ── Date Function ────────────────────────
  {
    topic: "date_function",
    patterns: [
      /\bDATEADD\s*\(/i,
      /\bDATEDIFF\s*\(/i,
      /\bGETDATE\s*\(\)/i,
      /\bSYSDATETIME\s*\(\)/i,
      /\bCURRENT_TIMESTAMP\b/i,
      /\bFORMAT\s*\(.*date/i,
      /\bYEAR\s*\(|\bMONTH\s*\(|\bDAY\s*\(/i,
      /\bEOMonth\s*\(/i,
      /\bDATEFROMPARTS\s*\(/i,
      /\bhàm\s+ngày\b|\bhàm\s+thời\s+gian\b/i,       // Vietnamese
      /\bxử\s+lý\s+ngày\b|\bdữ\s+liệu\s+ngày\b/i,
    ],
  },

  // ── String Function ──────────────────────
  {
    topic: "string_function",
    patterns: [
      /\bLEN\s*\(|\bLENGTH\s*\(/i,
      /\bSUBSTRING\s*\(/i,
      /\bCHARINDEX\s*\(|\bPATINDEX\s*\(/i,
      /\bREPLACE\s*\(/i,
      /\bSTUFF\s*\(/i,
      /\bUPPER\s*\(|\bLOWER\s*\(/i,
      /\bLTRIM\s*\(|\bRTRIM\s*\(|\bTRIM\s*\(/i,
      /\bCONCAT\s*\(|\bCONCAT_WS\s*\(/i,
      /\bSTRING_AGG\s*\(|\bSTRING_SPLIT\s*\(/i,
      /\bhàm\s+chuỗi\b/i,
    ],
  },

  // ── Math / Numeric Function ───────────────
  {
    topic: "math_function",
    patterns: [
      /\bABS\s*\(/i,
      /\bROUND\s*\(/i,
      /\bCEILING\s*\(|\bFLOOR\s*\(/i,
      /\bPOWER\s*\(|\bSQRT\s*\(/i,
      /\bMODULO\b|%\s*\d+/,
      /\bhàm\s+số\b|\bhàm\s+toán\b/i,
    ],
  },

  // ── Aggregate Function ───────────────────
  {
    topic: "aggregate_function",
    patterns: [
      /\bSUM\s*\(|\bAVG\s*\(|\bCOUNT\s*\(/i,
      /\bMIN\s*\(|\bMAX\s*\(/i,
      /\bGROUP\s+BY\b/i,
      /\bHAVING\b/i,
      /\bDISTINCT\b/i,
    ],
  },

  // ── Conversion Function ──────────────────
  {
    topic: "conversion_function",
    patterns: [
      /\bCAST\s*\(/i,
      /\bCONVERT\s*\(/i,
      /\bTRY_CAST\s*\(|\bTRY_CONVERT\s*\(/i,
      /\bPARSE\s*\(|\bTRY_PARSE\s*\(/i,
    ],
  },

  // ── JOIN ────────────────────────────────
  {
    topic: "join",
    patterns: [
      /\bINNER\s+JOIN\b/i,
      /\bLEFT\s+(OUTER\s+)?JOIN\b/i,
      /\bRIGHT\s+(OUTER\s+)?JOIN\b/i,
      /\bFULL\s+(OUTER\s+)?JOIN\b/i,
      /\bCROSS\s+JOIN\b/i,
    ],
  },

  // ── Subquery / CTE ───────────────────────
  {
    topic: "subquery",
    patterns: [
      /\bWITH\s+\w+\s+AS\s*\(/i,
      /\bEXISTS\s*\(/i,
      /\bNOT\s+EXISTS\s*\(/i,
      /\bIN\s*\(\s*SELECT\b/i,
      /\bsubquery\b/i,
    ],
  },

  // ── Index ────────────────────────────────
  {
    topic: "index",
    patterns: [
      /\bCREATE\s+(UNIQUE\s+)?(CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\b/i,
      /\bINCLUDE\s*\(/i,
      /\bCLUSTERED\b|\bNONCLUSTERED\b/i,
    ],
  },

  // ── View ─────────────────────────────────
  {
    topic: "view",
    patterns: [
      /\bCREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i,
      /\bALTER\s+VIEW\b/i,
    ],
  },

  // ── DDL ──────────────────────────────────
  {
    topic: "ddl",
    patterns: [
      /\bCREATE\s+TABLE\b/i,
      /\bALTER\s+TABLE\b/i,
      /\bDROP\s+TABLE\b/i,
      /\bTRUNCATE\s+TABLE\b/i,
    ],
  },

  // ── DML ──────────────────────────────────
  {
    topic: "dml",
    patterns: [
      /\bINSERT\s+(INTO\s+)?\w+/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+(FROM\s+)?\w+/i,
      /\bMERGE\s+\w+/i,
    ],
  },
];

// ─────────────────────────────────────────────
// SCORE-BASED CLASSIFIER
// ─────────────────────────────────────────────

/**
 * Classify a chunk's content into a single topic.
 *
 * Strategy: tally match counts per topic, return the winner.
 * Falls back to "general" when no rule fires.
 *
 * @param {string} content - chunk text
 * @param {string} [section] - section heading (optional, also scanned)
 * @returns {string} topic slug
 */
const classifyTopic = (content = "", section = "") => {
  const combined = `${section}\n${content}`;

  const scores = {};

  for (const rule of TOPIC_RULES) {
    let count = 0;
    for (const pat of rule.patterns) {
      const matches = combined.match(new RegExp(pat.source, pat.flags + "g"));
      if (matches) count += matches.length;
    }
    if (count > 0) scores[rule.topic] = (scores[rule.topic] || 0) + count;
  }

  if (Object.keys(scores).length === 0) return "general";

  // Return topic with highest score
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
};

/**
 * Classify an array of chunks (from chunkText / aiChunkText).
 * Mutates each chunk in-place, adds `chunk.topic`.
 *
 * @param {Array<{content:string, section:string}>} chunks
 * @returns {Array} same array with `.topic` set
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
 * Given a plain-text question, infer which topics are relevant.
 * Used by RAG to filter chunks at retrieval time.
 *
 * @param {string} question
 * @returns {string[]} array of topic slugs (empty = no filter, search all)
 */
const inferTopicsFromQuestion = (question = "") => {
  const matched = [];

  for (const rule of TOPIC_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(question)) {
        if (!matched.includes(rule.topic)) matched.push(rule.topic);
        break; // one match per rule is enough
      }
    }
  }

  // Vietnamese keywords for common intents
  const q = question.toLowerCase();

  if (!matched.length) {
    // Broad-keyword heuristics (Vietnamese)
    if (/ngày|tháng|năm|thời gian|date|time/.test(q)) matched.push("date_function");
    if (/chuỗi|ký tự|string|văn bản|text/.test(q)) matched.push("string_function");
    if (/thủ tục|stored proc|procedure|exec/.test(q)) matched.push("stored_procedure");
    if (/bảng tạm|temp table|biến bảng|table variable/.test(q)) matched.push("temp_table");
    if (/điều kiện|if else|vòng lặp|while|control/.test(q)) matched.push("control_flow");
    if (/tổng hợp|tổng|đếm|trung bình|group by/.test(q)) matched.push("aggregate_function");
    if (/chuyển đổi|cast|convert/.test(q)) matched.push("conversion_function");
    if (/kết hợp bảng|join|kết nối/.test(q)) matched.push("join");
    if (/cửa sổ|window|rank|row_number|over/.test(q)) matched.push("window_function");
    if (/trigger|kích hoạt/.test(q)) matched.push("trigger");
    if (/giao dịch|transaction|commit|rollback/.test(q)) matched.push("transaction");
    if (/xử lý lỗi|try catch|error/.test(q)) matched.push("error_handling");
    if (/con trỏ|cursor/.test(q)) matched.push("cursor");
  }

  return matched; // empty array → caller should NOT filter (broad question)
};

module.exports = { classifyTopic, classifyChunks, inferTopicsFromQuestion };
