const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const verifyToken = require("../middlewares/authMiddleware");

router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/refresh", authController.refreshToken);

// Các route cần đăng nhập
router.get("/me", verifyToken, authController.getMe);
router.get("/instructors", verifyToken, authController.getInstructors); 
router.put("/profile", verifyToken, authController.updateProfile);
router.put("/change-password", verifyToken, authController.changePassword);

module.exports = router;