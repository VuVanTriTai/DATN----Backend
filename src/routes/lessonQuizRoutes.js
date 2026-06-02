// routes/lessonQuizRoutes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/lessonQuizController");
const verifyToken = require("../middlewares/authMiddleware");

// Sinh quiz pool từ RAG cho 1 bài học (gọi 1 lần sau khi tạo khoá)
router.post("/:lessonId/generate-pool", verifyToken, ctrl.generatePool);

// Lấy câu hỏi thích nghi theo trình độ (đáp án đã ẩn)
router.get("/:lessonId/questions",      verifyToken, ctrl.getAdaptiveQuestions);

// Nộp bài + nhận kết quả thích nghi (remedial / normal / advanced)
router.post("/:lessonId/submit-adaptive", verifyToken, ctrl.submitAdaptive);

// Lấy lịch sử điểm từng bài của 1 khoá học
router.get("/scores/:planId",           verifyToken, ctrl.getLessonScores);

module.exports = router;
