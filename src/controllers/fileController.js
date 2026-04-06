const { extractTextFromFile } = require('../utils/extractText');

const extractText = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Vui lòng upload một file.' });
        }
        // Kiểm tra xem Cloudinary có trả về path (URL) không
        console.log("✅ File đã lên Cloudinary:", req.file.path);

        // Gọi util để trích xuất văn bản (PDF/DOCX)
        const content = await extractTextFromFile(req.file);

        if (!content || content.trim().length < 50) {
            return res.status(400).json({ success: false, message: 'Tài liệu quá ngắn hoặc không thể đọc được nội dung.' });
        }

        return res.status(200).json({
            success: true,
            fileUrl: req.file.path, // Đây là link để bạn lưu vào Database
            fileName: req.file.originalname,
            textLength: content.length,
            content: content.trim() // Trả về để Frontend lưu vào state rawText
        });

    } catch (error) {
        console.error('FileController Error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Lỗi trong quá trình xử lý file.'
        });
    }
};

module.exports = { extractText };