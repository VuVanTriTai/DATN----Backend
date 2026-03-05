const express = require('express');
const router = express.Router();
const multer = require('multer');
const fileController = require('../controllers/fileController');

// Cấu hình multer lưu tạm vào bộ nhớ (Memory Storage) để lấy buffer
const storage = multer.memoryStorage();

// Validate file type
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'text/plain', 
        'application/pdf', 
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png'
    ];

    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Định dạng file không hợp lệ. Chỉ chấp nhận TXT, PDF, DOCX, JPG, PNG.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // Giới hạn 10MB
});

// Định nghĩa API endpoint
router.post('/extract', upload.single('file'), fileController.extractText);

module.exports = router;