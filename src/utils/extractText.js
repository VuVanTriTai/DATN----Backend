const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');

/**
 * Hàm xử lý trích xuất văn bản dựa trên loại file
 * @param {Object} file - Object file từ multer (req.file)
 */
const extractTextFromFile = async (file) => {
    const mimetype = file.mimetype;
    const buffer = file.buffer;

    try {
        // 1. Xử lý file TXT
        if (mimetype === 'text/plain') {
            return buffer.toString('utf8');
        }

        // 2. Xử lý file PDF
        if (mimetype === 'application/pdf') {
            const data = await pdf(buffer);
            return data.text;
        }

        // 3. Xử lý file DOCX (Word)
        if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return result.value; // Văn bản thuần túy
        }

        // 4. Xử lý Ảnh (JPG, PNG) bằng OCR
        if (mimetype.startsWith('image/')) {
            const { data: { text } } = await Tesseract.recognize(
                buffer,
                'vie+eng', // Ngôn ngữ: Tiếng Việt + Tiếng Anh
                { logger: m => console.log(m) } // Có thể bỏ qua nếu không muốn log tiến trình
            );
            return text;
        }

        throw new Error('Định dạng file không được hỗ trợ để trích xuất văn bản.');
    } catch (error) {
        throw new Error(`Lỗi trích xuất: ${error.message}`);
    }
};

module.exports = { extractTextFromFile };