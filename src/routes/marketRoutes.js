const express = require("express");
const router = express.Router();
const marketController = require("../controllers/marketController");
const verifyToken = require("../middlewares/authMiddleware");

// GET /api/market/courses
router.get("/courses", verifyToken, marketController.getMarketCourses);

router.get("/courses/:id/preview", verifyToken, marketController.getCoursePreview);
router.post("/courses/:id/import", verifyToken, marketController.importCourse);

// GET /api/market/instructor/:instructorId/courses — khóa học public của 1 giảng viên
router.get("/instructor/:instructorId/courses", verifyToken, marketController.getCoursesByInstructor);

// GET /api/market/my-listings — instructor xem khóa học của mình đang trên market
router.get("/my-listings", verifyToken, marketController.getMyListings);

// PATCH /api/market/courses/:id/unlist — instructor gỡ khóa học khỏi market
router.patch("/courses/:id/unlist", verifyToken, marketController.unlistCourse);


// GET /api/market/my-imports -- hoc vien xem danh sach khoa hoc da import
router.get("/my-imports", verifyToken, marketController.getMyImports);

// DELETE /api/market/my-imports/:id -- hoc vien xoa khoa hoc da import khoi kho ca nhan
router.delete("/my-imports/:id", verifyToken, marketController.removeImport);

module.exports = router;