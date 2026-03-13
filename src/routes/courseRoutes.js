const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const verifyToken = require('../middlewares/authMiddleware');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// Đây là API sẽ thực hiện việc lưu vào MongoDB
router.post('/process', verifyToken, upload.single('file'), courseController.processStudyDocument);

module.exports = router;