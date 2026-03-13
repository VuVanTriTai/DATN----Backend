const express = require('express');
const router = express.Router();
const planController = require('../controllers/planController');
const verifyToken = require('../middlewares/authMiddleware');

router.post('/generate-from-text', verifyToken, planController.createPlanFromText);
router.get('/:id', verifyToken, planController.getPlanDetails);

// Dòng số 11 (hoặc 10) phải khớp với tên hàm đã viết ở Controller
router.get('/:id/lesson/:dayNumber', verifyToken, planController.getLessonDetail);

module.exports = router;