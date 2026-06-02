const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/instructorDirectoryController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");

// ── PUBLIC (cần đăng nhập) ─────────────────────────────────
// Lấy danh sách lĩnh vực hệ thống
router.get("/fields", verifyToken, ctrl.getTeachingFields);

// Học viên xem danh sách giáo viên (lọc theo lĩnh vực, sắp xếp)
router.get("/", verifyToken, ctrl.getInstructorDirectory);

// Học viên đánh giá giáo viên
router.post("/:instructorId/rate", verifyToken, checkRole(["learner"]), ctrl.rateInstructor);

// Học viên xem đánh giá của mình cho 1 giáo viên
router.get("/:instructorId/my-rating", verifyToken, ctrl.getMyRating);

// Xem tất cả đánh giá của 1 giáo viên
router.get("/:instructorId/ratings", verifyToken, ctrl.getInstructorRatings);

// ── INSTRUCTOR ONLY ────────────────────────────────────────
// Giáo viên xem hồ sơ của mình
router.get("/me", verifyToken, checkRole(["instructor"]), ctrl.getMyInstructorProfile);

// Giáo viên cập nhật lĩnh vực giảng dạy
router.put("/my-fields", verifyToken, checkRole(["instructor"]), ctrl.updateMyFields);

module.exports = router;
