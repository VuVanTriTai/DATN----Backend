// services/fileParserService.js
const fs = require("fs");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const extractTextFromFile = async (filePath, mimetype) => {
  try {
    const buffer = fs.readFileSync(filePath);

    // PDF
    if (mimetype === "application/pdf") {
      const data = await pdfParse(buffer);
      return data.text;
    }

    // DOCX
    if (mimetype.includes("wordprocessingml")) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    return "";
  } catch (err) {
    console.error("❌ Extract error:", err.message);
    return "";
  }
};

module.exports = { extractTextFromFile };