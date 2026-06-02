const express = require("express");
const router = express.Router();
const instructorController = require("../controllers/instructorController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");

// Giảng viên lấy danh sách khóa học mình dạy
router.get("/my-courses", verifyToken, checkRole(['instructor']), instructorController.getMyCourses);

// Giảng viên xem chi tiết Dashboard của 1 khóa học
router.get("/course/:planId/stats", verifyToken, checkRole(['instructor']), instructorController.getCourseDashboardStats);


module.exports = router;