const express = require('express');
const router = express.Router();
const planController = require('../controllers/planController');
const verifyToken = require('../middlewares/authMiddleware');

// Tạo lộ trình từ văn bản đã trích xuất
router.post('/generate-from-text', verifyToken, planController.createPlanFromText);

// Lấy toàn bộ bài học của 1 Plan
router.get('/:id', verifyToken, planController.getPlanDetails);

module.exports = router;