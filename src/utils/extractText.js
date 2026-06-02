"use strict";

const axios = require("axios");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Dùng cleanText từ utils (đã decode HTML entities + xóa noise markers)
const { cleanText } = require("./cleanText");

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const DEBUG_DIR = path.join(__dirname, "../debug");
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

const MAX_BUFFER_MB = 60;     // Buffer tối đa 60MB
const MAX_TEXT_CHARS = 150000; // Text tối đa gửi vào pipeline

// Đường dẫn đến Python script docling
const DOCLING_SCRIPT = path.join(__dirname, "../scripts/docling_extract.py");

// Tìm Python executable (python3 hoặc python)
const PYTHON_CMD = (() => {
  const candidates = ["python3", "python", "py"];
  return candidates[0]; // Node sẽ thử lần lượt trong runDocling
})();

// ─────────────────────────────────────────────
// METADATA
// ─────────────────────────────────────────────
const buildMetadata = (file, text, method = "docling") => ({
  fileName: file.originalname || file.path || "unknown",
  mimeType: file.mimetype,
  wordCount: text.split(/\s+/).filter(Boolean).length,
  lineCount: text.split("\n").length,
  tableCount: (text.match(/\|/g) || []).length > 10 ? 1 : 0, // Markdown tables có |
  extractMethod: method,
});

// ─────────────────────────────────────────────
// SAVE DEBUG
// ─────────────────────────────────────────────
const saveDebug = (text, metadata) => {
  try {
    fs.writeFileSync(path.join(DEBUG_DIR, "debug_extracted.txt"), text, "utf-8");
    fs.writeFileSync(
      path.join(DEBUG_DIR, "debug_metadata.json"),
      JSON.stringify(metadata, null, 2),
      "utf-8"
    );
    console.log(`✅ Debug saved (method: ${metadata.extractMethod})`);
  } catch (_) { }
};

// ─────────────────────────────────────────────
// GỌI DOCLING QUA PYTHON SUBPROCESS
// ─────────────────────────────────────────────
const runDocling = (filePath) => {
  return new Promise((resolve, reject) => {
    const pythonCandidates = ["python3", "python", "py"];
    let attempt = 0;

    const tryNext = () => {
      if (attempt >= pythonCandidates.length) {
        return reject(new Error(
          "Không tìm thấy Python. Vui lòng cài Python 3 và chạy: pip install docling"
        ));
      }

      const cmd = pythonCandidates[attempt++];
      console.log(`[Docling] Thử với: ${cmd} ${DOCLING_SCRIPT} ${filePath}`);

      const proc = spawn(cmd, [DOCLING_SCRIPT, filePath], {
        timeout: 120000, // 2 phút timeout
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      const stdoutChunks = [];
      const stderrChunks = [];

      proc.stdout.on("data", (d) => { stdoutChunks.push(d); });
      proc.stderr.on("data", (d) => { stderrChunks.push(d); });

      proc.on("error", (err) => {
        // Lệnh không tồn tại → thử lệnh tiếp theo
        if (err.code === "ENOENT") {
          console.warn(`[Docling] ${cmd} không tìm thấy, thử lệnh tiếp...`);
          return tryNext();
        }
        reject(err);
      });

      proc.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (stderr) {
          // In stderr để debug nhưng không fail ngay
          const filtered = stderr.split("\n")
            .filter(l => !l.startsWith("WARNING") && l.trim())
            .join("\n");
          if (filtered) console.warn(`[Docling stderr] ${filtered.substring(0, 500)}`);
        }

        try {
          // Lấy dòng JSON cuối cùng trong stdout (docling có thể in log)
          const lines = stdout.trim().split("\n");
          const jsonLine = lines.reverse().find(l => l.trim().startsWith("{"));
          if (!jsonLine) {
            return reject(new Error(`Docling không trả về JSON. stdout: ${stdout.substring(0, 300)}`));
          }
          const result = JSON.parse(jsonLine);
          if (!result.success) {
            return reject(new Error(result.error || "Docling thất bại"));
          }
          resolve(result);
        } catch (parseErr) {
          reject(new Error(`Parse JSON thất bại: ${parseErr.message} | stdout: ${stdout.substring(0, 200)}`));
        }
      });
    };

    tryNext();
  });
};

// ─────────────────────────────────────────────
// MAIN ENTRY
// ─────────────────────────────────────────────
const extractTextFromFile = async (file) => {
  // Bước 1: Lấy buffer từ file (Cloudinary URL hoặc local path)
  let tempFilePath = null;
  let buffer;

  try {
    if (file.path && (file.path.startsWith('http://') || file.path.startsWith('https://'))) {
      const response = await axios.get(file.path, {
        responseType: "arraybuffer",
        timeout: 60000,
      });
      buffer = Buffer.from(response.data);
    } else {
      // Local path (ví dụ: uploads/temp/...)
      buffer = fs.readFileSync(file.path);
    }

    // Memory guard
    const bufferMB = buffer.length / (1024 * 1024);
    console.log(`[Extract] Buffer: ${bufferMB.toFixed(1)}MB`);
    if (bufferMB > MAX_BUFFER_MB) {
      throw new Error(
        `File quá lớn (${bufferMB.toFixed(0)}MB). Tối đa ${MAX_BUFFER_MB}MB để xử lý an toàn.`
      );
    }

    const ext = path.extname(file.originalname || ".pdf").toLowerCase() || ".pdf";
    let rawText = "";
    let method = "";

    // Bước 2: Chọn phương pháp trích xuất theo đuôi file
    if (ext === '.docx') {
      console.log("[Mammoth] Đang chạy mammoth cho file Word...");
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: buffer });
      rawText = result.value;
      method = "mammoth";
    } else {
      // Lưu tạm ra đĩa để docling đọc
      tempFilePath = path.join(os.tmpdir(), `docling_${Date.now()}${ext}`);
      fs.writeFileSync(tempFilePath, buffer);
      console.log(`[Docling] Lưu file tạm: ${tempFilePath}`);

      console.log("[Docling] Đang chạy docling...");
      const doclingResult = await runDocling(tempFilePath);
      rawText = doclingResult.text;
      method = doclingResult.method || "docling";
    }

    if (!rawText || rawText.length < 20) {
      throw new Error(`Công cụ (${method}) không extract được text từ tài liệu`);
    }

    // Bước 4: Clean text
    let cleaned = cleanText(rawText);

    // Smart truncation cho file cực lớn
    if (cleaned.length > MAX_TEXT_CHARS) {
      console.warn(`[Extract] Text quá dài (${cleaned.length} ký tự) → cắt thông minh`);
      const keepFront = Math.floor(MAX_TEXT_CHARS * 0.6);
      const keepBack = MAX_TEXT_CHARS - keepFront;
      cleaned =
        cleaned.slice(0, keepFront) +
        "\n\n[... NỘI DUNG ĐÃ ĐƯỢC CẮT BỚT DO FILE QUÁ LỚN ...] \n\n" +
        cleaned.slice(-keepBack);
    }

    const metadata = buildMetadata(file, cleaned, method);
    saveDebug(cleaned, metadata);

    return { text: cleaned, metadata };

  } catch (err) {
    console.error("[extractText] Error:", err.message);
    throw err;
  } finally {
    // Xóa file tạm dù thành công hay thất bại
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Docling] Đã xóa file tạm: ${tempFilePath}`);
      } catch (_) { }
    }
  }
};

module.exports = { extractTextFromFile };