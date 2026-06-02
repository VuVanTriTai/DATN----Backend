// routes/documentRoutes.js
const express = require("express");
const router = express.Router();
const { upload } = require("../middlewares/uploadMiddleware");
const authMiddleware = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");
const {
  uploadDocument,
  getMyDocuments,
  deleteDocument
} = require("../controllers/documentController");

/**
 * Upload file (PDF/DOCX)
 */
router.post("/", authMiddleware, checkRole(['learner']), upload.single("file"), uploadDocument);

/**
 * List
 */
router.get("/", authMiddleware, getMyDocuments);

/**
 * Delete
 */
router.delete("/:id", authMiddleware, deleteDocument);



module.exports = router;