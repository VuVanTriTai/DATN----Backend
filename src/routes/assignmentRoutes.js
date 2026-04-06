const express = require("express");
const router = express.Router();
const assignmentController = require("../controllers/assignmentController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");
const upload = require("../middlewares/uploadMiddleware");

// Route cho Learner nộp bài
router.post("/submit", verifyToken, checkRole(['learner']), upload.single("file"), assignmentController.uploadAssignment);

// Dòng 12: Route cho Instructor lấy danh sách bài chờ chấm
router.get("/instructor/pending", verifyToken, checkRole(['instructor']), assignmentController.getPendingAssignments);

// Route cho Instructor chấm điểm
router.put("/grade/:id", verifyToken, checkRole(['instructor']), assignmentController.gradeAssignment);

module.exports = router;