// routes/courseRoutes.js
const express = require("express");
const router = express.Router();

const courseController = require("../controllers/courseController");
const verifyToken = require("../middlewares/authMiddleware");

router.post("/analyze", verifyToken, courseController.processAndAnalyze);
router.post("/regenerate", verifyToken, courseController.regeneratePreview);
router.post("/create", verifyToken, courseController.finalizeCreateCourse);
router.get("/my-plans", verifyToken, courseController.getMyPlans);
router.delete("/:id", verifyToken, courseController.deletePlan);

module.exports = router;