const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const verifyToken = require('../middlewares/authMiddleware');

// Route 1: Tìm kiếm nội dung liên quan trong tài liệu
router.post('/search', verifyToken, aiController.searchRelevantContent);

// Route 2: Chat hỏi đáp dựa trên nội dung tài liệu (RAG)
router.post('/chat-doc', verifyToken, aiController.chatWithDocument);

module.exports = router;