const express = require("express");
const router = express.Router();
const verifyToken = require("../middlewares/authMiddleware");
const isAdmin = require("../middlewares/isAdmin");
const {
  getDashboardStats,
  getAllUsers,
  getUserDetail,
  updateUserRole,
  banUser,
  unbanUser,
  deleteUser,
  resetUserPassword,
  getAllCourses,
  getCourseDetail,
  deleteCourse,
  toggleFeatured,
} = require("../controllers/adminController");

// Tất cả route admin đều phải qua verifyToken + isAdmin
router.use(verifyToken, isAdmin);

// --- Dashboard ---
router.get("/stats", getDashboardStats);

// --- User Management ---
router.get("/users", getAllUsers);
router.get("/users/:id", getUserDetail);
router.patch("/users/:id/role", updateUserRole);
router.patch("/users/:id/ban", banUser);
router.patch("/users/:id/unban", unbanUser);
router.delete("/users/:id", deleteUser);
router.patch("/users/:id/reset-password", resetUserPassword);

// --- Course Management ---
router.get("/courses", getAllCourses);
router.get("/courses/:id", getCourseDetail);
router.delete("/courses/:id", deleteCourse);
router.patch("/courses/:id/toggle-featured", toggleFeatured);

module.exports = router;
