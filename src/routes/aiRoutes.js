const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const verifyToken = require('../middlewares/authMiddleware');

// Route 1: Chỉ tìm nội dung liên quan
router.post('/search', verifyToken, aiController.searchRelevantContent);

// Route 2: Chat và trả lời dựa trên tài liệu (RAG)
router.post('/chat-doc', verifyToken, aiController.chatWithDocument);

module.exports = router;