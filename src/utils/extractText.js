// utils/extractText.js — OPTIMIZED TABLE SUPPORT VERSION
"use strict";

const axios   = require("axios");
const pdfParse = require("pdf-parse");
const mammoth  = require("mammoth");

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

// ─────────────────────────────────────────────
// TABLE RECOVERY HELPERS
// ─────────────────────────────────────────────

/**
 * Convert mammoth table element → Markdown table
 */
const mammothTableToMarkdown = (tableElement) => {
  try {
    const rows = tableElement.children || [];
    if (!rows.length) return "";

    const parsedRows = rows.map((row) => {
      const cells = (row.children || []).map((cell) => {
        const cellText = (cell.children || [])
          .map((para) =>
            (para.children || [])
              .map((run) => run.value || "")
              .join("")
          )
          .join(" ")
          .replace(/\|/g, "\\|") // escape pipe
          .trim();
        return cellText || " ";
      });
      return cells;
    });

    if (!parsedRows.length) return "";

    const header    = parsedRows[0];
    const separator = header.map(() => "---");
    const body      = parsedRows.slice(1);

    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`),
    ];

    return lines.join("\n");
  } catch {
    return "";
  }
};

/**
 * Custom mammoth transform: table → markdown paragraph
 */
const mammothTransformDocument = (document) => {
  const transformElement = (element) => {
    if (!element) return element;

    if (element.type === "table") {
      const markdown = mammothTableToMarkdown(element);
      return {
        type:     "paragraph",
        children: [{ type: "run", value: `\n\n${markdown}\n\n` }],
      };
    }

    if (Array.isArray(element.children)) {
      return {
        ...element,
        children: element.children.map(transformElement),
      };
    }

    return element;
  };

  return {
    ...document,
    children: (document.children || []).map(transformElement),
  };
};

/**
 * Phục hồi bảng từ PDF text (whitespace-separated)
 * 
 * Ví dụ PDF raw:
 *   "Tên    Tuổi    Điểm\nAn     20      8.5\nBình   21      9.0"
 * 
 * → Convert thành:
 *   | Tên | Tuổi | Điểm |
 *   |-----|------|------|
 *   | An  | 20   | 8.5  |
 *   | Bình| 21   | 9.0  |
 */
const recoverPdfTables = (rawText) => {
  const lines  = rawText.split(/\r?\n/);
  const result = [];

  let tableBuffer      = [];
  let inTableCandidate = false;

  const flushTable = () => {
    if (tableBuffer.length < 2) {
      // Không đủ dữ liệu → không phải bảng
      result.push(...tableBuffer);
      tableBuffer = [];
      inTableCandidate = false;
      return;
    }

    // Parse columns: split trên tab hoặc 2+ spaces
    const parsedRows = tableBuffer.map((line) =>
      line
        .split(/\t|  {2,}/)
        .map((c) => c.trim().replace(/\|/g, "\\|"))
        .filter(Boolean)
    );

    // Filter rows có số cột hợp lý so với header
    const colCount = parsedRows[0].length;
    const validRows = parsedRows.filter(
      (r) => r.length >= Math.max(2, colCount - 1) && r.length <= colCount + 1
    );

    if (validRows.length >= 2 && colCount >= 2) {
      const header    = validRows[0].map((c) => c || " ");
      const separator = header.map(() => "---");
      const body      = validRows.slice(1);

      result.push(`\n| ${header.join(" | ")} |`);
      result.push(`| ${separator.join(" | ")} |`);
      body.forEach((row) => {
        // Pad cho đủ số cột
        const padded = Array.from({ length: header.length }, (_, i) => row[i] || " ");
        result.push(`| ${padded.join(" | ")} |`);
      });
      result.push("");
    } else {
      // Không hợp lệ → giữ nguyên
      result.push(...tableBuffer);
    }

    tableBuffer      = [];
    inTableCandidate = false;
  };

  for (const line of lines) {
    const isTableLike =
      /\t|  {2,}/.test(line) &&                           // có tab hoặc 2+ spaces
      line.trim().length > 0 &&                           // không empty
      line.trim().split(/\t|  {2,}/).filter(Boolean).length >= 2; // ít nhất 2 cột

    if (isTableLike) {
      inTableCandidate = true;
      tableBuffer.push(line);
    } else {
      if (inTableCandidate) flushTable();
      result.push(line);
    }
  }

  // Flush cuối file
  if (inTableCandidate) flushTable();

  return result.join("\n");
};

// ─────────────────────────────────────────────
// TEXT POST-PROCESSING
// ─────────────────────────────────────────────

/**
 * Clean text nhẹ nhàng — KHÔNG phá Markdown tables
 */
const postProcessExtractedText = (raw) => {
  if (!raw || typeof raw !== "string") return "";

  return raw
    // Normalize line endings
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Remove control chars (trừ tab, newline)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Max 2 consecutive blank lines
    .replace(/\n{3,}/g, "\n\n")
    // Trim mỗi dòng — EXCEPT Markdown table rows
    .split("\n")
    .map((line) => {
      // Giữ nguyên table rows (start with |)
      if (/^\s*\|/.test(line)) return line;
      return line.trimEnd(); // chỉ trim right
    })
    .join("\n")
    .trim();
};

// ─────────────────────────────────────────────
// FILE METADATA
// ─────────────────────────────────────────────

/**
 * Extract metadata để AI hiểu file context
 */
const buildFileMetadata = (file, extractedText) => {
  const wordCount  = extractedText.split(/\s+/).filter(Boolean).length;
  const lineCount  = extractedText.split(/\n/).length;
  const tableCount = (extractedText.match(/^\s*\|/gm) || []).length; // count table rows
  const hasFormulas =
    /[=+\-*/^√∑∏≤≥≈∫∂]/.test(extractedText) ||
    /\b(theorem|lemma|định lý|mệnh đề|công thức|formula|equation)\b/i.test(extractedText);

  return {
    fileName:   file.originalname || file.path?.split("/").pop() || "unknown",
    mimeType:   file.mimetype,
    wordCount,
    lineCount,
    tableCount,
    hasFormulas,
    estimatedComplexity:
      wordCount > 5000 ? "high" : 
      wordCount > 1500 ? "medium" : "low",
  };
};

// ─────────────────────────────────────────────
// MAIN EXTRACTION FUNCTION
// ─────────────────────────────────────────────

/**
 * extractTextFromFile — return { text, metadata }
 * Thay vì chỉ return text thuần → giúp AI hiểu document tốt hơn
 */
const extractTextFromFile = async (file) => {
  try {
    // Download from Cloudinary
    console.log(`[extractText] Downloading: ${file.path}`);
    
    const response = await axios.get(file.path, {
      responseType: "arraybuffer",
      timeout:      30_000,
      maxContentLength: MAX_FILE_SIZE_BYTES,
    });

    const buffer = Buffer.from(response.data);

    if (buffer.length === 0) {
      throw new Error("File rỗng hoặc không thể tải từ Cloudinary.");
    }

    let rawText = "";

    // ── PDF Processing ──
    if (file.mimetype === "application/pdf") {
      console.log(`[extractText] Processing PDF...`);
      
      const pdfData = await pdfParse(buffer, {
        normalizeWhitespace: false,      // giữ layout để detect tables
        disableCombineTextItems: false,
      });

      rawText = recoverPdfTables(pdfData.text);
    }

    // ── DOCX Processing ──
    else if (
      file.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      console.log(`[extractText] Processing DOCX...`);
      
      // Dùng convertToHtml + transform thay vì extractRawText
      const htmlResult = await mammoth.convertToHtml(
        { buffer },
        {
          transformDocument: mammothTransformDocument,
          styleMap: [
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh", 
            "p[style-name='Heading 3'] => h3:fresh",
          ],
        }
      );

      // Strip HTML → keep structure
      rawText = htmlResult.value
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n")
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n")
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n")
        .replace(/<li[^>]*>(.*?)<\/li>/gi, "\n- $1")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<p[^>]*>(.*?)<\/p>/gi, "\n$1\n")
        .replace(/<tr[^>]*>/gi, "\n")
        .replace(/<th[^>]*>(.*?)<\/th>/gi, "| $1 ")
        .replace(/<td[^>]*>(.*?)<\/td>/gi, "| $1 ")
        .replace(/<[^>]+>/g, "") // strip remaining tags
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
    }

    // ── TXT / Other Processing ──
    else {
      console.log(`[extractText] Processing TXT/Other...`);
      
      // Try UTF-8 first, fallback to latin1 if replacement chars found
      const utf8 = buffer.toString("utf-8");
      rawText = utf8.includes("\uFFFD")
        ? buffer.toString("latin1")
        : utf8;
    }

    // Validate extraction result
    if (!rawText || rawText.trim().length < 20) {
      throw new Error(
        "Không thể trích xuất nội dung từ tài liệu. " +
        "File có thể bị hỏng, mã hóa, hoặc chỉ chứa hình ảnh."
      );
    }

    const text     = postProcessExtractedText(rawText);
    const metadata = buildFileMetadata(file, text);

    console.log(
      `[extractText] Success: ${metadata.fileName} → ` +
      `${metadata.wordCount} words, ${metadata.tableCount} table rows, ` +
      `complexity=${metadata.estimatedComplexity}`
    );

    return { text, metadata };

  } catch (error) {
    console.error("[extractText] Error:", error.message);
    throw new Error(`Không thể đọc nội dung tài liệu: ${error.message}`);
  }
};

module.exports = { extractTextFromFile };
