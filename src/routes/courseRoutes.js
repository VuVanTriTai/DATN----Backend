const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const verifyToken = require('../middlewares/authMiddleware');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// 1. Route phân tích file (Đây là chỗ gây lỗi 404 nếu thiếu)
router.post('/analyze', verifyToken, courseController.processAndAnalyze);

// 2. Route chia lại lộ trình khi đổi số ngày
router.post('/regenerate', verifyToken, courseController.regeneratePreview);

//router.post('/analyze', verifyToken, upload.single('file'), courseController.processAndAnalyze);
//router.post('/regenerate', verifyToken, courseController.regeneratePreview);
router.post('/create', verifyToken, courseController.finalizeCreateCourse);



module.exports = router;