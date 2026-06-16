// =========================================================================
// 🗺️ FILE: src/routes/planRoutes.js - TUYẾN ĐƯỜNG LỘ TRÌNH HỌC (PLAN ROUTER)
// Tác dụng: Nhận các yêu cầu liên quan đến Lộ trình học (Tạo mới, Phân tích File, Học thử, Chia sẻ).
// Luồng đi: Frontend -> planRoutes -> planController
// =========================================================================

const express = require("express");
const router = express.Router();
const planController = require("../controllers/planController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");

// 🟢 PHÂN KHÚC 1: XỬ LÝ TÀI LIỆU VÀ TẠO LỘ TRÌNH BẰNG AI (Dành cho Học viên)
// -------------------------------------------------------------------------

// 1. Phân tích tài liệu thô & Thiết lập mục tiêu ban đầu (POST /api/plan/analyze)
// Tác dụng: Nhận text trích xuất từ file và trả về phân tích tổng quan cùng Lộ trình khung (Syllabus) dự kiến.
router.post("/analyze", verifyToken, checkRole(['learner']), planController.processAndAnalyze);

// 2. Xác nhận tạo Khóa học hoàn chỉnh (POST /api/plan/create)
// Tác dụng: Cắt nhỏ tài liệu (Chunking), lưu nhúng vector, sinh chi tiết bài giảng cho từng ngày và lưu vào DB.
router.post("/create", verifyToken, checkRole(['learner']), planController.finalizeCreateCourse);


// 🟢 PHÂN KHÚC 2: QUẢN LÝ LỘ TRÌNH HỌC CỦA NGƯỜI DÙNG (Yêu cầu đăng nhập)
// -------------------------------------------------------------------------

// 3. Lấy toàn bộ lộ trình của riêng tôi (GET /api/plan/me)
router.get("/me", verifyToken, planController.getMyPlans);

// 4. Tìm kiếm người dùng hệ thống để chia sẻ lộ trình (GET /api/plan/search-user)
router.get("/search-user", verifyToken, planController.searchUser);

// 5. Lấy danh sách lộ trình người khác chia sẻ với tôi (GET /api/plan/shared/me)
router.get("/shared/me", verifyToken, planController.getSharedWithMe);

// 6. Lấy thông tin chi tiết của 1 lộ trình học (GET /api/plan/:id)
router.get("/:id", verifyToken, planController.getPlanDetails);

// 7. Lấy nội dung chi tiết bài học của ngày cụ thể (GET /api/plan/:id/lesson/:dayNumber)
router.get("/:id/lesson/:dayNumber", verifyToken, planController.getLessonDetail);

// 7b. Tạo lại nội dung bài học bằng AI (POST /api/plan/:id/lesson/:dayNumber/regenerate)
// Học viên sở hữu lộ trình có thể yêu cầu AI viết lại bài giảng, RAG vẫn dùng tài liệu gốc.
router.post("/:id/lesson/:dayNumber/regenerate", verifyToken, checkRole(['learner']), planController.regenerateLesson);

// 8. Xóa lộ trình học (soft-delete) (DELETE /api/plan/:id)
router.delete("/:id", verifyToken, planController.deletePlan);

// 9. Chỉ định hoặc thay đổi Giáo viên hướng dẫn cho lộ trình (PUT /api/plan/:id/instructor)
router.put("/:id/instructor", verifyToken, planController.updateInstructor);


// 🟢 PHÂN KHÚC 3: CHIA SẺ & ĐĂNG TẢI LỘ TRÌNH (Marketplace & Private Share)
// -------------------------------------------------------------------------

// 10. Chia sẻ lộ trình chung (POST /api/plan/:id/share)
router.post("/:id/share", verifyToken, planController.sharePlan);

// 11. Đăng lộ trình lên chợ khóa học công khai (POST /api/plan/:id/share-market)
router.post("/:id/share-market", verifyToken, planController.shareToMarket);

// 12. Lấy kết quả / thống kê tiến độ học của lộ trình (GET /api/plan/:id/results)
router.get("/:id/results", verifyToken, planController.getPlanResults);

// 13. Chia sẻ riêng tư cho một người học khác bằng ID (POST /api/plan/:id/share-private)
router.post("/:id/share-private", verifyToken, planController.sharePrivate);

module.exports = router;