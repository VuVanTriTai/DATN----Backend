const { extractTextFromFile } = require('../utils/extractText');

const extractText = async (req, res) => {
    try {
        // Kiểm tra nếu không có file
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng upload một file.'
            });
        }

        // Gọi util để trích xuất văn bản
        const content = await extractTextFromFile(req.file);

        // Trả về kết quả
        return res.status(200).json({
            success: true,
            fileType: req.file.mimetype,
            fileName: req.file.originalname,
            textLength: content.length,
            content: content.trim()
        });

    } catch (error) {
        console.error('FileController Error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Có lỗi xảy ra trong quá trình xử lý file.'
        });
    }
};

module.exports = {
    extractText
};