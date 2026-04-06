const express = require("express");
const router = express.Router();
const enrollmentController = require("../controllers/enrollmentController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");

// Instructor xem danh sách học viên đang quản lý
router.get("/my-students", verifyToken, checkRole(['instructor']), enrollmentController.getMyStudents);

// Instructor chấp nhận hướng dẫn
router.put("/accept/:id", verifyToken, checkRole(['instructor']), enrollmentController.acceptStudent);

module.exports = router;