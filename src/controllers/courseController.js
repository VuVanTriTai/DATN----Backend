// ĐẦU FILE: Import đúng (phải có dấu {})
const { extractTextFromFile } = require('../utils/extractText');
const { chunkText } = require('../utils/chunkText'); 

const processStudyDocument = async (req, res) => {
    try {
        if (!req.file) return res.error("Không tìm thấy file", 400);

        const rawText = await extractTextFromFile(req.file);
        const textChunks = chunkText(rawText); // <--- Gọi hàm ở đây

        return res.success({
            fileName: req.file.originalname,
            totalChunks: textChunks.length,
            chunks: textChunks
        }, "Tài liệu đã được xử lý xong.");

    } catch (error) {
        console.error("Lỗi:", error);
        return res.error(error.message, 500);
    }
};

// CUỐI FILE CONTROLLER: Xuất hàm xử lý API của controller
module.exports = { processStudyDocument };