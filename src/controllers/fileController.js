// src/controllers/fileController.js
const { extractTextFromFile } = require('../utils/extractText');

const extractText = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Vui lòng upload một file.' });
        }

        // SỬA TẠI ĐÂY: extractTextFromFile trả về { text, metadata }
        const result = await extractTextFromFile(req.file);
        
        const { text, metadata } = result;

        // Trả về kết quả đầy đủ cho Frontend
        return res.status(200).json({
            success: true,
            fileUrl: req.file.location || req.file.path,
            fileName: req.file.originalname,
            textLength: text.length,
            content: text.trim(), // Bây giờ text mới là string để trim
            metadata: metadata     // Trả về metadata (số từ, độ khó...) để hiển thị
        });

    } catch (error) {
        console.error('FileController Error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Có lỗi xảy ra trong quá trình xử lý file.'
        });
    } finally {
        // Xóa file tạm ở local sau khi extract xong để tránh đầy ổ cứng
        if (req.file && req.file.path && !req.file.path.startsWith('http')) {
            const fs = require('fs');
            if (fs.existsSync(req.file.path)) {
                try {
                    fs.unlinkSync(req.file.path);
                } catch (e) {
                    console.error("Lỗi khi xóa file tạm:", e);
                }
            }
        }
    }
};

const uploadFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Vui lòng upload một file.' });
        }
        return res.status(200).json({
            success: true,
            fileUrl: req.file.location || req.file.path,
            fileName: req.file.originalname,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = { extractText, uploadFile };