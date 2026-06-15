// src/routes/fileRoutes.js
const express = require('express');
const router = express.Router();
// 1. Sử dụng middleware upload
const { upload, uploadLocal } = require('../middlewares/uploadMiddleware');
const fileController = require('../controllers/fileController');
const verifyToken = require('../middlewares/authMiddleware');

/**
 * Tuyến đường trích xuất văn bản (sử dụng uploadLocal)
 * POST /api/file/extract
 */
router.post(
    '/extract',
    verifyToken,
    upload.single('file'), 
    fileController.extractText
);

// Route upload file lấy link 
router.post(
    '/upload',
    verifyToken,
    upload.single('file'),
    fileController.uploadFile
);

module.exports = router;