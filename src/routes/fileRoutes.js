// src/routes/fileRoutes.js
const express = require('express');
const router = express.Router();
// 1. Sử dụng middleware upload đã được cấu hình Cloudinary (chỉ require 1 lần)
const upload = require('../middlewares/uploadMiddleware'); 
const fileController = require('../controllers/fileController');
const verifyToken = require('../middlewares/authMiddleware');

/**
 * Tuyến đường trích xuất văn bản và upload lên Cloudinary
 * POST /api/file/extract
 */
router.post(
    '/extract', 
    verifyToken, 
    upload.single('file'), // Sử dụng biến 'upload' từ middleware đã require ở trên
    fileController.extractText
);

module.exports = router;