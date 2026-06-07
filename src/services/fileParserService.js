"use strict";

const path = require("path");
const { extractTextFromFile: extractWithMetadata } = require("../utils/extractText");

const guessMimeType = (filePath) => {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".txt") return "text/plain";
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"].includes(ext)) return `image/${ext.slice(1)}`;
  return "application/octet-stream";
};

const normalizeInput = (fileOrPath, mimetype) => {
  if (typeof fileOrPath === "string") {
    return {
      path: fileOrPath,
      originalname: path.basename(fileOrPath),
      mimetype: mimetype || guessMimeType(fileOrPath),
    };
  }

  return fileOrPath;
};

const extractTextFromFile = async (fileOrPath, mimetype) => {
  const result = await extractWithMetadata(normalizeInput(fileOrPath, mimetype));
  return result;
};

module.exports = { extractTextFromFile };
