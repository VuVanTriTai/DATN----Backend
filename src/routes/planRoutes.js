const express = require("express");
const router = express.Router();
const planController = require("../controllers/planController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");
const { upload } = require('../middleware/uploadMiddleware'); // Cloudinary multer
const { authenticate } = require('../middleware/auth');




// ✅ NEW: Upload & extract endpoint
//router.post('/upload-extract', authenticate, upload.single('file'), planController.uploadAndExtract);
 
// Tuyến đường dành cho Learner tạo bài (Dòng 8 thường ở đây)
router.post("/analyze", verifyToken, checkRole(['learner']), planController.processAndAnalyze);
router.post("/create", verifyToken, checkRole(['learner']), planController.finalizeCreateCourse);

// Quản lý lộ trình
router.get("/me", verifyToken, planController.getMyPlans);
router.get("/:id", verifyToken, planController.getPlanDetails);
router.get("/:id/lesson/:dayNumber", verifyToken, planController.getLessonDetail);
router.delete("/:id", verifyToken, planController.deletePlan);
router.put("/:id/instructor", verifyToken, planController.updateInstructor);
router.post("/:id/share", verifyToken, planController.sharePlan);

module.exports = router;