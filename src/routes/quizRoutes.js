const express = require("express");
const router = express.Router();
const quizController = require("../controllers/quizController");
const verifyToken = require("../middlewares/authMiddleware");

// POST /api/quiz/generate (Cần token)
router.post("/generate", verifyToken, quizController.generateQuiz);

// GET /api/quiz (Cần token)
router.get("/", verifyToken, quizController.getAllQuizzes);

// GET /api/quiz/:id (Cần token và check owner)
router.get("/:id", verifyToken, quizController.getQuizById);

// GET /api/quiz/public/:id (Không cần token)
router.get("/public/:id", quizController.getQuizPublic);

// POST /api/quiz/submit (Cần token))
router.post("/submit/:id", verifyToken, quizController.submitQuiz);

// PUT /api/quiz/:id (Cần token)
router.put("/:id", verifyToken, quizController.updateQuiz);

// POST /api/quiz/start/:id (Cần token)
router.post("/start/:id", verifyToken, quizController.startQuiz);

// DELETE /api/quiz/:id (Cần token)
router.delete("/:id", verifyToken, quizController.deleteQuiz);

module.exports = router;
