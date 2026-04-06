// controllers/documentController.js
const Document = require("../models/Document");
const { extractTextFromFile } = require("../services/fileParserService");
const planService = require("../services/planService"); // RAG

/**
 * Upload + auto RAG
 */
const uploadDocument = async (req, res) => {
  try {
    const userId = req.user.id;

    if (!req.file) {
      return res.error("Không có file nào được tải lên", 400);
    }

    const { path, mimetype, originalname } = req.file;
    console.log("📄 Đang xử lý file:", originalname);

    // 1. Trích xuất văn bản
    const text = await extractTextFromFile(path, mimetype);

    // 2. Kiểm tra độ dài văn bản (Logic chuyển từ Route sang đây)
    if (!text || text.trim().length < 50) {
      return res.error("Nội dung tài liệu quá ngắn để xử lý.", 400);
    }

    if (text.length > 100000) {
      return res.error("Tài liệu quá lớn (tối đa 100,000 ký tự).", 400);
    }

    // 3. Lưu tài liệu vào Database
    const doc = await Document.create({
      userId,
      title: originalname,
      content: text,
      fileUrl: path
    });

    // 4. Xử lý RAG (Lưu Vector 1024-dim cho Chat)
    console.log("🧠 Đang tạo Embedding cho tài liệu...");
    await planService.processAndStoreDocument(doc._id, text);

    return res.success(doc, "Tài liệu đã được tải lên và sẵn sàng để hỗ trợ học tập.");

  } catch (err) {
    console.error("❌ Upload error:", err.message);
    return res.error(err.message, 500);
  }
};

/**
 * Lấy tài liệu
 */
const getMyDocuments = async (req, res) => {
  try {
    const docs = await Document.find({ userId: req.user.id }).sort({ createdAt: -1 });
    
    // Trả về theo chuẩn res.success để Frontend nhận được res.success = true
    return res.success(docs); 
  } catch (err) {
    return res.error(err.message, 500);
  }
};

/**
 * Xóa
 */
const deleteDocument = async (req, res) => {
  try {
    await Document.deleteOne({
      _id: req.params.id,
      userId: req.user.id
    });

    res.success(null, "Đã xóa");
  } catch (err) {
    res.error(err.message);
  }
};

module.exports = {
  uploadDocument,
  getMyDocuments,
  deleteDocument
};