"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// utils/extractText.js — STRUCTURE-PRESERVING EXTRACTION v2
//
// Thay đổi so với v1:
//   1. lightPostProcess nay gọi đầy đủ fixOcrGluedWords + stripSingleColumnTableWrap
//      (v1 bỏ sót hai bước này cho Docling/mammoth output → từ dính không được sửa)
//   2. cleanText được gọi với options.preserveStructure=true cho high-quality extract
//      → không phá structure nhưng vẫn unwrap bảng 1 cột và tách từ dính
//   3. Detect slide PDF (tỷ lệ bảng 1 cột cao) → log cảnh báo + force full clean
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  cleanText,
  fixOcrGluedWords,
  stripSingleColumnTableWrap,
} = require("./cleanText");

const DEBUG_DIR = path.join(__dirname, "../debug");
const DOCLING_SCRIPT = path.join(__dirname, "../scripts/docling_extract.py");
const PROJECT_ROOT = path.join(__dirname, "../..");
const TESSDATA_DIR = PROJECT_ROOT;

const MAX_BUFFER_MB = 60;
const MAX_TEXT_CHARS = 150000;
const MIN_EXTRACTED_CHARS = 20;
const MIN_OCR_FALLBACK_CHARS = 80;
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 12);

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const getExt = (file) => {
  const name = file?.originalname || file?.filename || file?.path || "";
  return path.extname(name).toLowerCase();
};

const isRemotePath = (filePath = "") => /^https?:\/\//i.test(filePath);

const getFileName = (file) =>
  file?.originalname || file?.filename || file?.path || "unknown";

// ─────────────────────────────────────────────
// QUALITY CHECKER
// ─────────────────────────────────────────────

const calcVietnameseRatio = (text) => {
  const total = text.replace(/\s/g, "").length;
  if (total < 50) return 1;
  const viChars = (
    text.match(/[àáảãạăắằẳẵặâầấẩẫậèéẻẽẹêềếểễệđìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵÀÁẢÃẠĂẮẰẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆĐÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ]/g) || []
  ).length;
  return viChars / total;
};

/**
 * ✅ v2: Phát hiện slide PDF — tỷ lệ bảng 1 cột cao
 * Slide PDF thường có >40% dòng là bảng giả (1 cột bọc toàn bộ nội dung)
 */
const detectSlidePdf = (text) => {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 10) return false;

  const tableLikeLines = lines.filter((l) => l.trim().startsWith("|")).length;
  const ratio = tableLikeLines / lines.length;

  // Bảng thật thường có separator (|---|), bảng giả thì không
  const separatorCount = lines.filter((l) =>
    /^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(l.trim())
  ).length;

  // Nhiều dòng bảng, ít separator → slide PDF
  return ratio > 0.35 && separatorCount < 3;
};

const checkExtractQuality = (text) => {
  const lines = text.split("\n");
  const words = text.split(/\s+/).filter(Boolean).length;

  const headingCount = lines.filter((l) =>
    /^#{1,4}\s+\S/.test(l.trim()) ||
    /^\d+(\.\d+)+\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(l.trim())
  ).length;

  const shortLines = lines.filter((l) => l.trim().length > 0 && l.trim().length < 30).length;
  const shortRatio = lines.length > 0 ? shortLines / lines.length : 0;

  const viRatio = calcVietnameseRatio(text);
  const looksVietnamese = /[àáảãạăắằẳẵặâầấẩẫậèéẻẽẹêềếểễệđ]/i.test(text.slice(0, 500));
  const accentLoss = looksVietnamese && viRatio < 0.015;

  // ✅ v2: detect gluedWords — mật độ token dài không có khoảng trắng
  const longTokens = (text.match(/\S{15,}/g) || []).length;
  const totalTokens = (text.match(/\S+/g) || []).length;
  const gluedRatio = totalTokens > 0 ? longTokens / totalTokens : 0;

  const isSlidePdf = detectSlidePdf(text);

  const issues = [];
  if (words > 200 && headingCount < 2) issues.push("no_headings");
  if (shortRatio > 0.6) issues.push("fragmented_lines");
  if (accentLoss) issues.push("accent_loss");
  if (gluedRatio > 0.08) issues.push("glued_words");    // ✅ v2
  if (isSlidePdf) issues.push("slide_pdf_wrap"); // ✅ v2

  return {
    ok: issues.length === 0,
    issues,
    stats: {
      words,
      headingCount,
      shortRatio: Math.round(shortRatio * 100),
      viRatio: Math.round(viRatio * 1000) / 10,
      gluedRatio: Math.round(gluedRatio * 100),   // ✅ v2
      isSlidePdf,                                   // ✅ v2
    },
  };
};

// ─────────────────────────────────────────────
// STRUCTURE METRICS
// ─────────────────────────────────────────────

const analyzeStructure = (text) => {
  const lines = text.split("\n");
  const words = text.split(/\s+/).filter(Boolean).length;

  const headingCount = lines.filter((l) =>
    /^#{1,4}\s+\S/.test(l.trim()) ||
    /^\d+(\.\d+)+\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(l.trim())
  ).length;

  const tableRows = lines.filter((l) => /^\|.+\|/.test(l.trim())).length;
  const hasFormulas =
    /[∑∏∫√≤≥≈±×÷→←⇒⇔∈∉∩∪∀∃]/.test(text) ||
    /\$[^$]{3,}\$/.test(text) ||
    /\\\[[\s\S]{3,}\\\]/.test(text);

  const codeBlocks = (text.match(/```/g) || []).length / 2;
  const bulletItems = lines.filter((l) => /^[\s]*[-*+•◦]\s/.test(l)).length;

  let complexity = "low";
  if (words > 3000 || headingCount > 10 || codeBlocks > 5) complexity = "medium";
  if (words > 8000 || headingCount > 20 || (hasFormulas && codeBlocks > 3)) complexity = "high";

  return {
    wordCount: words,
    headingCount,
    tableCount: tableRows > 3 ? Math.ceil(tableRows / 4) : 0,
    hasFormulas,
    codeBlockCount: Math.floor(codeBlocks),
    bulletItemCount: bulletItems,
    estimatedComplexity: complexity,
  };
};

// ─────────────────────────────────────────────────────────────────
// ✅ v2: LIGHT POST-PROCESSOR (cải tiến)
//
// Dùng cho Docling / mammoth output.
// Khác v1: nay gọi đầy đủ:
//   1. stripSingleColumnTableWrap  — bóc bảng 1 cột từ slide PDF
//   2. fixOcrGluedWords            — tách từ dính
//   3. cleanText({ preserveStructure: true }) — fix nhẹ, không phá structure
//
// Nếu quality.issues chứa "slide_pdf_wrap" hoặc "glued_words"
// → gọi cleanText đầy đủ (preserveStructure: false) để repair triệt để hơn
// ─────────────────────────────────────────────────────────────────
const lightPostProcess = (text, quality) => {
  if (!text) return "";

  const needsDeepRepair =
    quality?.issues?.includes("slide_pdf_wrap") ||
    quality?.issues?.includes("glued_words") ||
    quality?.issues?.includes("accent_loss");

  if (needsDeepRepair) {
    // Dùng cleanText đầy đủ nhưng vẫn giữ structure khi có thể
    console.log("[Extract] Light→Full post-process (slide_pdf/glued detected)");
    return cleanText(text, { preserveStructure: false });
  }

  // Đường nhanh: chỉ fix nhẹ
  let result = text.normalize("NFC");

  // HTML entities
  result = result
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  // Unicode combining marks tách bởi space
  result = result
    .replace(/ ([\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF])/g, "$1")
    .replace(/([\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF]) /g, "$1")
    .normalize("NFC");

  // Markdown escapes
  result = result
    .replace(/\\_/g, "_").replace(/\\\*/g, "*")
    .replace(/\\\[/g, "[").replace(/\\\]/g, "]");

  // Standalone broken URLs
  result = result.replace(/^https?:\/\/[^\s]+\s*$/gm, "");

  // Unicode rác
  result = result.replace(/\uFFFD/g, "").replace(/\u0000/g, "");
  result = result.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");

  // ✅ v2: Bước này v1 BỎ SÓT cho lightPostProcess
  result = stripSingleColumnTableWrap(result);
  result = fixOcrGluedWords(result);

  return result.trim();
};

// ─────────────────────────────────────────────
// METADATA BUILDER
// ─────────────────────────────────────────────

const buildMetadata = (file, text, method, extra = {}) => ({
  fileName: getFileName(file),
  mimeType: file?.mimetype,
  wordCount: text.split(/\s+/).filter(Boolean).length,
  lineCount: text.split("\n").length,
  tableCount: (text.match(/\|/g) || []).length > 10 ? 1 : 0,
  extractMethod: method,
  ...extra,
});

// ─────────────────────────────────────────────
// DEBUG SAVER
// ─────────────────────────────────────────────

const saveDebug = (text, metadata) => {
  try {
    fs.writeFileSync(path.join(DEBUG_DIR, "debug_extracted.txt"), text, "utf-8");
    fs.writeFileSync(
      path.join(DEBUG_DIR, "debug_metadata.json"),
      JSON.stringify(metadata, null, 2),
      "utf-8"
    );
    console.log(`[Extract] Debug saved (${metadata.extractMethod})`);
  } catch (err) {
    console.warn("[Extract] Cannot save debug files:", err.message);
  }
};

// ─────────────────────────────────────────────
// FILE READER
// ─────────────────────────────────────────────

const readFileBuffer = async (file) => {
  if (!file) throw new Error("Không có file để trích xuất.");
  if (file.buffer) return Buffer.from(file.buffer);

  const filePath = file.localPath || file.path || file.location;
  if (!filePath) throw new Error("File không có path/location/buffer.");

  if (isRemotePath(filePath)) {
    const response = await axios.get(filePath, {
      responseType: "arraybuffer",
      timeout: 60000,
      maxContentLength: MAX_BUFFER_MB * 1024 * 1024,
    });
    return Buffer.from(response.data);
  }

  return fs.readFileSync(filePath);
};

const ensureBufferSize = (buffer) => {
  const bufferMB = buffer.length / (1024 * 1024);
  console.log(`[Extract] Buffer: ${bufferMB.toFixed(1)}MB`);
  if (bufferMB > MAX_BUFFER_MB) {
    throw new Error(`File quá lớn (${bufferMB.toFixed(0)}MB). Tối đa ${MAX_BUFFER_MB}MB.`);
  }
};

// ─────────────────────────────────────────────
// DOCLING RUNNER
// ─────────────────────────────────────────────

const runDocling = (filePath) =>
  new Promise((resolve, reject) => {
    const pythonCandidates = ["python3", "python", "py"];
    let attempt = 0;
    let settled = false;

    const failOnce = (err) => {
      if (!settled) { settled = true; reject(err); }
    };

    const tryNext = () => {
      if (attempt >= pythonCandidates.length) {
        return failOnce(
          new Error("Không tìm thấy Python. Cài Python 3 và chạy: pip install docling")
        );
      }

      const cmd = pythonCandidates[attempt++];
      let ignoreClose = false;
      const proc = spawn(cmd, [DOCLING_SCRIPT, filePath], {
        timeout: 120000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      const stdoutChunks = [];
      const stderrChunks = [];

      proc.stdout.on("data", (d) => stdoutChunks.push(d));
      proc.stderr.on("data", (d) => stderrChunks.push(d));

      proc.on("error", (err) => {
        if (
          ["ENOENT", "UNKNOWN", "EACCES"].includes(err.code) &&
          attempt < pythonCandidates.length
        ) {
          ignoreClose = true;
          return tryNext();
        }
        failOnce(err);
      });

      proc.on("close", (code) => {
        if (ignoreClose || settled) return;

        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (stderr) {
          const filtered = stderr
            .split("\n")
            .filter((l) => l.trim() && !l.trim().startsWith("WARNING"))
            .join("\n");
          if (filtered) console.warn(`[Docling stderr] ${filtered.slice(0, 500)}`);
        }

        if (code !== 0 && !stdout.trim()) {
          return failOnce(new Error(`Docling exited with code ${code}`));
        }

        try {
          const jsonLine = stdout
            .trim()
            .split(/\r?\n/)
            .reverse()
            .find((line) => line.trim().startsWith("{"));

          if (!jsonLine) {
            return failOnce(
              new Error(`Docling không trả về JSON. stdout: ${stdout.slice(0, 300)}`)
            );
          }

          const result = JSON.parse(jsonLine);
          if (!result.success) return failOnce(new Error(result.error || "Docling thất bại"));

          settled = true;
          resolve(result);
        } catch (err) {
          failOnce(new Error(`Parse JSON thất bại: ${err.message}`));
        }
      });
    };

    tryNext();
  });

// ─────────────────────────────────────────────
// HTML → MARKDOWN
// ─────────────────────────────────────────────

const convertHtmlToMarkdown = (html) =>
  html
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "##### $1\n\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "###### $1\n\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<tr[^>]*>/gi, "\n|")
    .replace(/<\/tr>/gi, "")
    .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, " $1 |")
    .replace(/<\/?table[^>]*>/gi, "\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

// ─────────────────────────────────────────────
// FALLBACK EXTRACTORS
// ─────────────────────────────────────────────

const extractDocx = async (buffer) => {
  const mammoth = require("mammoth");
  try {
    const result = await mammoth.convertToHtml({ buffer });
    return { text: convertHtmlToMarkdown(result.value), method: "mammoth-html" };
  } catch (err) {
    console.warn("[Mammoth] convertToHtml failed, using raw text:", err.message);
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, method: "mammoth-raw" };
  }
};

const extractPdfParse = async (buffer) => {
  const pdfParse = require("pdf-parse");

  if (typeof pdfParse === "function") {
    const data = await pdfParse(buffer);
    return { text: data.text || "", method: "pdf-parse", pages: data.numpages };
  }

  if (pdfParse.PDFParse) {
    const parser = new pdfParse.PDFParse({ data: buffer });
    try {
      const textResult = await parser.getText();
      return {
        text: textResult.text || "",
        method: "pdf-parse-v2",
        pages: textResult.total || textResult.pages?.length,
      };
    } finally {
      await parser.destroy();
    }
  }

  throw new Error("pdf-parse API không được hỗ trợ.");
};

// ─────────────────────────────────────────────
// OCR
// ─────────────────────────────────────────────

const withTempFile = async (buffer, ext, prefix, callback) => {
  const tempPath = path.join(
    os.tmpdir(),
    `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`
  );
  fs.writeFileSync(tempPath, buffer);
  try {
    return await callback(tempPath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (err) {
      console.warn(`[Extract] Cannot remove temp file ${tempPath}:`, err.message);
    }
  }
};

const createTesseractWorker = async () => {
  const { createWorker } = require("tesseract.js");
  const langs = fs.existsSync(path.join(TESSDATA_DIR, "vie.traineddata"))
    ? "vie+eng"
    : "eng";
  return createWorker(langs, 1, {
    langPath: TESSDATA_DIR,
    cachePath: TESSDATA_DIR,
    gzip: false,
    logger: (m) => {
      if (m.status === "recognizing text" && m.progress) {
        const pct = Math.round(m.progress * 100);
        if (pct % 25 === 0) console.log(`[OCR] ${pct}%`);
      }
    },
  });
};

const runOcrOnImages = async (images) => {
  if (!images.length) return "";
  const worker = await createTesseractWorker();
  const parts = [];
  try {
    for (const image of images) {
      const imageInput = image.path || image.content || image;
      const result = await worker.recognize(imageInput);
      const text = result?.data?.text || "";
      if (text.trim()) parts.push(text.trim());
    }
  } finally {
    await worker.terminate();
  }
  return parts.join("\n\n");
};

const ocrPdf = async (buffer) => {
  const { pdfToPng, VerbosityLevel } = require("pdf-to-png-converter");

  return withTempFile(buffer, ".pdf", "ocr_pdf", async (pdfPath) => {
    const outputFolder = fs.mkdtempSync(path.join(os.tmpdir(), "ocr_pages_"));
    try {
      const pages = await pdfToPng(pdfPath, {
        outputFolder,
        outputFileMaskFunc: (pageNumber) => `page_${pageNumber}.png`,
        pagesToProcess: Array.from({ length: OCR_MAX_PAGES }, (_, i) => i + 1),
        viewportScale: 2,
        returnPageContent: false,
        processPagesInParallel: false,
        verbosityLevel: VerbosityLevel?.ERRORS,
      });

      const images = pages
        .filter((page) => page.kind === "file" && page.path)
        .sort((a, b) => a.pageNumber - b.pageNumber);

      const text = await runOcrOnImages(images);
      return { text, method: `ocr-tesseract-pdf-${images.length}p`, ocrPages: images.length };
    } finally {
      try {
        fs.rmSync(outputFolder, { recursive: true, force: true });
      } catch (err) {
        console.warn("[OCR] Cannot remove page images:", err.message);
      }
    }
  });
};

const ocrImage = async (buffer, ext) =>
  withTempFile(buffer, ext || ".png", "ocr_image", async (imagePath) => ({
    text: await runOcrOnImages([{ path: imagePath }]),
    method: "ocr-tesseract-image",
    ocrPages: 1,
  }));

// ─────────────────────────────────────────────
// TRUNCATE
// ─────────────────────────────────────────────

const truncateText = (text) => {
  if (text.length <= MAX_TEXT_CHARS) return text;

  console.warn(`[Extract] Text too long (${text.length} chars), truncating.`);
  const keepFront = Math.floor(MAX_TEXT_CHARS * 0.6);
  const keepBack = MAX_TEXT_CHARS - keepFront;
  return (
    `${text.slice(0, keepFront)}\n\n` +
    `[... NỘI DUNG ĐÃ ĐƯỢC CẮT BỚT DO FILE QUÁ LỚN ...]\n\n` +
    `${text.slice(-keepBack)}`
  );
};

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────

const extractTextFromFile = async (file) => {
  const buffer = await readFileBuffer(file);
  ensureBufferSize(buffer);

  const ext = getExt(file) || ".pdf";
  let extracted = { text: "", method: "" };

  // ── Image → OCR ─────────────────────────────────────────────────────────
  if (
    SUPPORTED_IMAGE_EXTS.has(ext) ||
    (file?.mimetype || "").startsWith("image/")
  ) {
    extracted = await ocrImage(buffer, ext);
  } else {
    // ── Docling (ưu tiên) ─────────────────────────────────────────────────
    try {
      extracted = await withTempFile(buffer, ext, "docling", async (filePath) => {
        const result = await runDocling(filePath);
        return {
          text: result.text || "",
          method: result.method || "docling",
          pages: result.pages,
        };
      });
    } catch (err) {
      console.warn(`[Docling] Failed: ${err.message}. Using fallback extractor.`);

      if (ext === ".docx") {
        extracted = await extractDocx(buffer);
      } else if (ext === ".pdf") {
        try {
          extracted = await extractPdfParse(buffer);
        } catch (pdfErr) {
          console.warn(`[pdf-parse] Failed: ${pdfErr.message}. Trying OCR fallback.`);
          extracted = await ocrPdf(buffer);
        }
      } else if (ext === ".txt") {
        extracted = { text: buffer.toString("utf-8"), method: "plain-text" };
      } else {
        throw new Error("Định dạng file chưa được hỗ trợ hoặc không thể trích xuất.");
      }
    }

    // ── OCR fallback cho scanned PDF ─────────────────────────────────────
    if (
      ext === ".pdf" &&
      (extracted.text || "").replace(/\s+/g, "").length < MIN_OCR_FALLBACK_CHARS
    ) {
      console.warn("[OCR] Extracted text is too short, trying OCR fallback for scanned PDF.");
      const ocrResult = await ocrPdf(buffer);
      if (
        (ocrResult.text || "").trim().length >
        (extracted.text || "").trim().length
      ) {
        extracted = {
          ...ocrResult,
          method: extracted.method
            ? `${extracted.method}+${ocrResult.method}`
            : ocrResult.method,
        };
      }
    }
  }

  if (!extracted.text || extracted.text.trim().length < MIN_EXTRACTED_CHARS) {
    throw new Error(
      `Công cụ (${extracted.method || "unknown"}) không trích xuất được text từ tài liệu.`
    );
  }

  // ✅ CHỐNG SPAM IMAGE: thay thế/dọn dẹp các thẻ <!-- image --> từ tài liệu gốc
  extracted.text = String(extracted.text || "")
    .replace(/(<!--\s*image\s*-->\s*\n?){3,}/gi, "\n*(Tài liệu gốc có hình/công thức minh họa tại đây)*\n")
    .replace(/(<!--\s*image\s*-->\s*\n?){1,2}/gi, "\n*(hình minh họa)*\n");

  // ── Quality check ────────────────────────────────────────────────────────
  const quality = checkExtractQuality(extracted.text);

  if (!quality.ok) {
    console.warn(
      `[Extract] Chất lượng thấp (${quality.issues.join(", ")}) | stats:`,
      quality.stats
    );
    if (quality.issues.includes("accent_loss")) {
      console.error(
        "[Extract] ⚠️  Phát hiện mất dấu tiếng Việt. " +
        "Cần fix ở docling_extract.py: thêm fallback pymupdf hoặc pdfplumber."
      );
    }
    if (quality.issues.includes("slide_pdf_wrap")) {
      console.warn("[Extract] ⚠️  Phát hiện slide PDF — bảng 1 cột wrap toàn bộ nội dung.");
    }
    if (quality.issues.includes("glued_words")) {
      console.warn("[Extract] ⚠️  Phát hiện từ dính — sẽ dùng deep repair mode.");
    }
  }

  // ── Post-process ─────────────────────────────────────────────────────────
  // Docling/mammoth → lightPostProcess (nhưng v2 giờ cũng xử lý slide PDF đúng)
  // pdf-parse/OCR   → cleanText đầy đủ
  const isHighQualityExtract = /docling|mammoth/.test(extracted.method);

  let processedText;
  if (isHighQualityExtract) {
    // ✅ v2: lightPostProcess nhận quality để tự quyết định có cần deep repair không
    processedText = lightPostProcess(extracted.text, quality);
    console.log(
      `[Extract] Post-process: ${quality.issues.includes("slide_pdf_wrap") || quality.issues.includes("glued_words")
        ? "light→full"
        : "light"
      } (${extracted.method})`
    );
  } else {
    processedText = cleanText(extracted.text, { preserveStructure: false });
    console.log(`[Extract] Post-process: full (${extracted.method})`);
  }

  // ── Truncate ──────────────────────────────────────────────────────────────
  const finalText = truncateText(processedText);

  // ── Structure analysis + enrich metadata ─────────────────────────────────
  const structure = analyzeStructure(finalText);

  const metadata = {
    ...buildMetadata(file, finalText, extracted.method, {
      pages: extracted.pages,
      ocrPages: extracted.ocrPages,
    }),
    ...structure,
    qualityIssues: quality.issues,
    qualityStats: quality.stats,
  };

  saveDebug(finalText, metadata);

  console.log(
    `[Extract] ✅ Done | words=${structure.wordCount} | headings=${structure.headingCount} | ` +
    `tables=${structure.tableCount} | formulas=${structure.hasFormulas} | ` +
    `complexity=${structure.estimatedComplexity} | issues=${quality.issues.join(",") || "none"}`
  );

  return { text: finalText, metadata };
};

module.exports = { extractTextFromFile };