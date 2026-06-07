// src/controllers/fileController.js
const { extractTextFromFile } = require('../utils/extractText');

const extractText = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Vui lòng upload một file.' });
        }

        const result = await extractTextFromFile(req.file);
        const { text, metadata } = result;
        const publicFileUrl = (() => {
            const candidate = req.file.location || req.file.path;
            return /^https?:\/\//i.test(candidate || '') ? candidate : null;
        })();

        return res.status(200).json({
            success: true,
            fileUrl: publicFileUrl,
            // Fix: giải mã lại tên file bị mojibake trên Windows (UTF-8 bị đọc như latin1)
            fileName: (() => {
                try {
                    const raw = req.file.originalname || '';
                    // Nếu tên đã đọc đúng UTF-8 thì giữ nguyên
                    return Buffer.from(raw, 'latin1').toString('utf8').includes('\uFFFD')
                        ? raw
                        : Buffer.from(raw, 'latin1').toString('utf8');
                } catch { return req.file.originalname; }
            })(),
            textLength: text.length,
            content: text.trim(),
            metadata: metadata
        });

    } catch (error) {
        console.error('FileController Error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Có lỗi xảy ra trong quá trình xử lý file.'
        });
    } finally {
        // Fix EBUSY: dùng async delayed delete thay vì unlinkSync
        // Stream/handle của mammoth/docx có thể chưa được release khi finally chạy
        if (req.file?.path && !req.file.path.startsWith('http')) {
            const fs = require('fs');
            const filePath = req.file.path;
            const tryDelete = (attempt = 1) => {
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (e) {
                    if (e.code === 'EBUSY' && attempt < 4) {
                        // Retry sau 300ms, tối đa 3 lần
                        setTimeout(() => tryDelete(attempt + 1), 300 * attempt);
                    } else {
                        console.warn(`[FileCleanup] Không xóa được file tạm (attempt ${attempt}):`, e.code);
                    }
                }
            };
            // Đợi 200ms cho stream đóng hết rồi mới xóa
            setTimeout(() => tryDelete(), 200);
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
