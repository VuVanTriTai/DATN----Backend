const express = require("express");
const router = express.Router();
const attemptController = require("../controllers/attemptController");
const verifyToken = require("../middlewares/authMiddleware");

// GET /api/attempt (Cần token)
router.get("/", verifyToken, attemptController.getUserAttempts);

// GET /api/attempt/:id (Cần token)
router.get("/:id", verifyToken, attemptController.getAttemptById);

module.exports = router;
