const express = require("express");
const router = express.Router();
const attemptController = require("../controllers/attemptController");
const verifyToken = require("../middlewares/authMiddleware");

// GET /api/attempt/user (Cần token)
router.get("/user", verifyToken, attemptController.getUserAttempts);

// GET /api/attempt/:id (Cần token)
router.get("/:id", verifyToken, attemptController.getAttemptByQuizId);

// GET /api/attempt/:id/:number (Cần token)
router.get("/:id/:number", verifyToken, attemptController.getAttemptByNumber);

module.exports = router;
