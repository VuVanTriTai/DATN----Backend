const express = require("express");
const router = express.Router();
const instructorController = require("../controllers/instructorController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");

/**
 * CẤU HÌNH BẢO VỆ
 * Tất cả các tuyến đường dưới đây đều yêu cầu:
 * 1. Đã đăng nhập (verifyToken)
 * 2. Có vai trò là giảng viên (checkRole)
 */
router.use(verifyToken, checkRole(['instructor']));

// 1. Lấy danh sách khóa học đang dạy (Để hiện ở trang InstructorCourses.tsx)
// GET /api/instructor/my-courses
router.get("/my-courses", instructorController.getMyCourses);

// 2. Lấy danh sách TOÀN BỘ học viên đang hướng dẫn (Để hiện ở trang StudentList.tsx)
// GET /api/instructor/my-students
router.get("/my-students", instructorController.getMyStudents);

// 3. Lấy thông số Dashboard và Danh sách học viên của 1 khóa học cụ thể
// GET /api/instructor/course/:planId/stats
router.get("/course/:planId/stats", instructorController.getCourseDashboardStats);

// 4. Lấy chi tiết tiến độ và bài tập nộp của 1 học viên trong 1 khóa học cụ thể
// GET /api/instructor/course/:planId/student/:studentId
router.get("/course/:planId/student/:studentId", instructorController.getStudentDetail);

// 5. Lấy lịch sử tiến độ tổng quát của 1 học sinh (xuyên suốt các khóa học)
// GET /api/instructor/student/:studentId/progress
router.get("/student/:studentId/progress", instructorController.getStudentProgress);





// Ghi đè trực tiếp lên bài học (cập nhật ngay, học viên thấy luôn)
router.put("/lesson/:lessonId", verifyToken, checkRole(['instructor']), instructorController.updateStudentLesson);

// Lưu bản nháp GV (học viên chưa thấy cho đến khi GV bấm "Gửi")
router.post("/lesson/:lessonId/draft", verifyToken, checkRole(['instructor']), instructorController.saveLessonDraft);

// Gửi bản chỉnh sửa hoàn chỉnh cho học viên (merge draft → lesson + plan.status='reviewed')
router.post("/course/:planId/send-back", verifyToken, checkRole(['instructor']), instructorController.finalizeReview);

// Thêm ngày học mới vào lộ trình
router.post("/course/:planId/lesson", verifyToken, checkRole(['instructor']), instructorController.addLesson);

// Xóa ngày học khỏi lộ trình
router.delete("/lesson/:lessonId", verifyToken, checkRole(['instructor']), instructorController.deleteLesson);

module.exports = router;