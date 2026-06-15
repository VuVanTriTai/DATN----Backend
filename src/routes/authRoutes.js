// =========================================================================
// 🗺️ FILE: src/routes/authRoutes.js - BẢN ĐỒ ĐỊNH TUYẾN XÁC THỰC (AUTHENTICATION ROUTER)
// Tác dụng: Nhận yêu cầu (Request) từ trình duyệt (Frontend) dựa trên URL,
//           áp dụng các bộ soát vé (Middleware) và chuyển tiếp tới đầu bếp (Controller).
// Luồng đi: Frontend -> authRoutes -> [Middleware] -> authController
// =========================================================================

const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const verifyToken = require("../middlewares/authMiddleware");

// 🟢 NHÓM CÁC ROUTE CÔNG KHAI (Không yêu cầu đăng nhập trước)
// -------------------------------------------------------------------------

// 1. Nhận yêu cầu Đăng ký tài khoản (Frontend gửi POST lên /api/auth/register)
router.post("/register", authController.register);

// 2. Nhận yêu cầu Đăng nhập (Frontend gửi POST lên /api/auth/login)
router.post("/login", authController.login);

// 3. Nhận yêu cầu Đăng nhập thông qua Google OAuth2
router.post("/google-login", authController.googleLogin);

// 4. Nhận yêu cầu cấp lại Access Token mới bằng Refresh Token
router.post("/refresh", authController.refreshToken);


// 🔴 NHÓM CÁC ROUTE BẢO MẬT (Bắt buộc phải đính kèm Token đăng nhập hợp lệ)
// Cách hoạt động: Đi qua "verifyToken" trước, nếu hợp lệ mới chạy tiếp hàm ở controller.
// -------------------------------------------------------------------------

// 5. Lấy thông tin cá nhân của tài khoản đang đăng nhập (GET /api/auth/me)
router.get("/me", verifyToken, authController.getMe);

// 6. Lấy danh sách toàn bộ Giảng viên hệ thống (GET /api/auth/instructors)
router.get("/instructors", verifyToken, authController.getInstructors); 

// 7. Tìm kiếm người dùng khác bằng Email (GET /api/auth/search-user)
router.get("/search-user", verifyToken, authController.searchUser);

// 8. Cập nhật thông tin Hồ sơ cá nhân (PUT /api/auth/profile)
router.put("/profile", verifyToken, authController.updateProfile);

// 9. Đổi mật khẩu cá nhân (PUT /api/auth/change-password)
router.put("/change-password", verifyToken, authController.changePassword);

module.exports = router;