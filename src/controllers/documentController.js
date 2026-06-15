// src/controllers/documentController.js
const Document = require("../models/Document");
const Chunk = require("../models/Chunk"); // Để xóa dữ liệu vector liên quan
const { extractTextFromFile } = require("../services/fileParserService");
const planService = require("../services/planService");
const crypto = require("crypto");
/**
 * 1. Upload tài liệu và xử lý RAG (Lưu Vector cho Chat)
 */
const uploadDocument = async (req, res) => {
  try {
    const userId = req.user.id;
    const { originalname } = req.file; 

    // Kiểm tra file từ Multer/Cloudinary/R2
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Không có file nào được tải lên" });
    }

    // Cloudflare R2/Cloudinary trả về link nằm trong req.file.location hoặc req.file.path
    const cloudinaryLink = req.file.location || req.file.path;


    console.log("📄 Đang bóc tách file:", originalname);

    // 1. Trích xuất văn bản và metadata từ file
    const result = await extractTextFromFile(req.file);
    const text = result.text;
    const metadata = result.metadata;

    // 2. Kiểm tra tính hợp lệ của nội dung
    if (!text || text.trim().length < 50) {
      return res.status(400).json({ success: false, message: "Tài liệu quá ngắn hoặc không có nội dung chữ." });
    }

    if (text.length > 100000) {
      return res.status(400).json({ success: false, message: "Tài liệu quá lớn (tối đa 100,000 ký tự)." });
    }

    // 3. TẠO MÃ HASH ĐỂ KIỂM TRA TRÙNG LẶP
    const currentHash = crypto.createHash("md5").update(text).digest("hex");

    // 4. KIỂM TRA XEM TÀI LIỆU ĐÃ TỒN TẠI CHƯA
    let doc = await Document.findOne({ userId, contentHash: currentHash });

    if (doc) {
      console.log("♻️ Tài liệu đã tồn tại.");
      // Nếu bản ghi cũ thiếu link hoặc đang chứa đường dẫn local cũ, nâng cấp lên link Cloudinary mới
      const isOldLocal = doc.fileUrl && (doc.fileUrl.startsWith('uploads') || doc.fileUrl.includes('uploads/') || doc.fileUrl.includes('uploads\\'));
      const isNewRemote = cloudinaryLink && cloudinaryLink.startsWith('http');
      if (!doc.fileUrl || (isOldLocal && isNewRemote)) {
        doc.fileUrl = cloudinaryLink;
        await doc.save();
        console.log("✅ Đã cập nhật/nâng cấp fileUrl lên Cloudinary cho tài liệu cũ.");
      }
      return res.success(doc, "Tài liệu đã tồn tại và đã được cập nhật liên kết.");
    }

    // 5. LƯU TÀI LIỆU MỚI (Sử dụng lại biến doc đã let ở trên, không dùng const)
    doc = await Document.create({
      userId,
      title: originalname,
      content: text,
      fileUrl: cloudinaryLink,      // LƯU LINK CLOUDINARY VÀO ĐÂY
      contentHash: currentHash,
      metadata: metadata || {}
    });

    // 6. Xử lý RAG (Lưu Vector 1024-dim để hỗ trợ Chat)
    console.log("🧠 Đang tạo dữ liệu Vector cho tài liệu...");
    await planService.processAndStoreDocument(doc._id, text);

    return res.status(201).json({
      success: true,
      message: "Tài liệu đã được lưu và xử lý AI thành công.",
      data: doc
    });

  } catch (err) {
    console.error("❌ Upload error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 2. Lấy toàn bộ tài liệu đã tải lên của tôi
 */
const getMyDocuments = async (req, res) => {
  try {
    const docs = await Document.find({ userId: req.user.id }).sort({ createdAt: -1 });
    return res.success(docs);
  } catch (err) {
    console.error("❌ Get documents error:", err.message);
    return res.error(err.message, 500);
  }
};

/**
 * 3. Xóa tài liệu
 */
const deleteDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const doc = await Document.findOne({ _id: id, userId });
    if (!doc) return res.error("Không tìm thấy tài liệu", 404);

    // Xóa tài liệu trong DB
    await Document.findByIdAndDelete(id);

    // XÓA CẢ DỮ LIỆU VECTOR (CHUNKS) ĐỂ DỌN DẸP BỘ NHỚ
    await Chunk.deleteMany({ planId: id }); // Lưu ý: planId ở đây là OID của document trong hệ thống RAG

    return res.success(null, "Đã xóa tài liệu và dữ liệu AI liên quan.");
  } catch (err) {
    return res.error(err.message, 500);
  }
};

module.exports = {
  uploadDocument,
  getMyDocuments,
  deleteDocument
};