// planController.js — UPDATED với Table-Aware Extraction
const planService = require('../services/planService');
const { normalizeLearningGoals } = require('../constants/learningGoals');
const { extractTextFromFile } = require('../utils/extractText'); // ✅ NEW IMPORT
const Plan = require('../models/Plan');
const Lesson = require('../models/Lesson');
const Chunk = require('../models/Chunk');
const Enrollment = require('../models/Enrollment');
const Document = require("../models/Document");
const Assignment = require('../models/Assignment');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────
// NEW: UPLOAD & EXTRACT ENDPOINT
// ─────────────────────────────────────────────

/**
 * BƯỚC 0: Upload file → Extract text với table support
 * Endpoint này sẽ được gọi từ frontend khi user upload file
 */
const uploadAndExtract = async (req, res) => {
    try {
        // req.file được tạo bởi multer middleware (đã upload lên Cloudinary)
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ 
                success: false, 
                message: "Không có file được tải lên." 
            });
        }

        console.log("📁 Extracting text from uploaded file...");
        
        // Extract text với table support + metadata
        const { text, metadata } = await extractTextFromFile(file);
        
        if (!text || text.trim().length < 50) {
            return res.status(400).json({
                success: false,
                message: "File quá ngắn hoặc không thể đọc nội dung có nghĩa."
            });
        }

        console.log(
            `✅ Extraction thành công: ${metadata.wordCount} words, ` +
            `${metadata.tableCount} table rows, complexity=${metadata.estimatedComplexity}`
        );

        return res.status(200).json({
            success: true,
            message: "Đã trích xuất nội dung thành công.",
            data: {
                text,
                metadata,
                fileUrl: file.path, // Cloudinary URL
                originalName: file.originalname,
            }
        });

    } catch (error) {
        console.error("❌ Upload & Extract error:", error.message);
        return res.status(500).json({
            success: false,
            message: `Không thể đọc file: ${error.message}`
        });
    }
};

// ─────────────────────────────────────────────
// UPDATED: PROCESS & ANALYZE (với metadata)
// ─────────────────────────────────────────────

/**
 * BƯỚC 1: Phân tích tài liệu (Dành cho trang Review)
 * Updated để nhận metadata từ bước uploadAndExtract
 */
const processAndAnalyze = async (req, res) => {
    try {
        const { 
            text, 
            learningGoals: rawGoals,
            metadata // ✅ NEW: nhận metadata từ frontend
        } = req.body;
        
        if (!text) {
            return res.status(400).json({ 
                success: false, 
                message: "Không có văn bản." 
            });
        }

        // ✅ PASS METADATA vào analyzeDocument
        const result = await planService.analyzeDocument(text, rawGoals || {}, metadata);
        
        return res.success({
            rawText: text,
            analysis: result.analysis,
            previewPlan: result.previewPlan,
            metadata: metadata || null // trả metadata về cho frontend track
        });
        
    } catch (error) {
        console.error("❌ Process & Analyze error:", error.message);
        return res.error(error.message, 500);
    }
};

// ─────────────────────────────────────────────
// UPDATED: FINALIZE CREATE COURSE
// ─────────────────────────────────────────────

/**
 * BƯỚC 2: Tạo lộ trình chi tiết (RAG Auto-Pilot)
 * Updated để sử dụng metadata trong logging & optimization
 */
const finalizeCreateCourse = async (req, res) => {
    try {
        const { 
            title, 
            extractedText, 
            numDays, 
            instructorId, 
            previewPlan, 
            fileUrl, 
            learningGoals: rawGoals,
            metadata // ✅ NEW: metadata từ extraction step
        } = req.body;
        
        const learnerId = req.user.id;
        const learningGoals = normalizeLearningGoals(rawGoals || {});

        // Log metadata để debug
        if (metadata) {
            console.log(
                `📊 Document info: ${metadata.wordCount} words, ` +
                `${metadata.tableCount} table rows, ` +
                `formulas: ${metadata.hasFormulas ? 'Yes' : 'No'}, ` +
                `complexity: ${metadata.estimatedComplexity}`
            );
        }

        // 1. Tạo Document record
        const doc = await Document.create({
            userId: learnerId,
            title: title || metadata?.fileName || "Tài liệu gốc",
            content: extractedText,
            fileUrl: fileUrl,
            // ✅ Lưu metadata vào DB để sau này reference
            metadata: metadata || {}
        });

        if (!extractedText) {
            return res.error("Thiếu nội dung tài liệu.", 400);
        }

        // Normalize numDays
        let duration = parseInt(numDays);
        if (isNaN(duration)) {
            const match = String(numDays).match(/\d+/);
            duration = match ? parseInt(match[0]) : 7;
        }

        console.log("🚀 BẮT ĐẦU QUY TRÌNH TẠO LỘ TRÌNH RAG");

        // 2. Tạo Plan
        const plan = await Plan.create({
            title: title || metadata?.fileName || "Khóa học AI",
            owner: learnerId,
            instructorId: instructorId || null,
            documentId: doc._id,
            duration,
            learningGoals,
            // ✅ Lưu metadata summary vào plan
            documentMetadata: {
                wordCount: metadata?.wordCount || 0,
                hasFormulas: metadata?.hasFormulas || false,
                complexity: metadata?.estimatedComplexity || 'medium'
            }
        });

        // 3. Tạo Enrollment nếu có instructor
        if (plan.instructorId) {
            await Enrollment.create({
                learnerId: learnerId,
                instructorId: plan.instructorId,
                planId: plan._id,
                status: "pending"
            });
            console.log("✅ Đã gửi yêu cầu hướng dẫn.");
        }

        // 4. Process document → Vector DB với table-aware chunks
        console.log("📦 Đang chunk & embedding document với table support...");
        await planService.processAndStoreDocument(plan._id, extractedText);
        
        // Đợi Index cập nhật
        console.log("⏳ Đang đợi Index cập nhật (5s)...");
        await sleep(5000); 

        // 5. Generate syllabus
        const syllabus = (previewPlan && previewPlan.length > 0) 
            ? previewPlan 
            : (await planService.generateSyllabus(extractedText, duration, learningGoals)).syllabus;

        console.log(`📚 Bắt đầu tạo chi tiết cho ${syllabus.length} bài học...`);

        // 6. Generate lessons với RAG
        const previousTopics = [];
        const usedChunkSignatures = [];
        
        for (const item of syllabus) {
            const currentItem = {
                day: item.dayNumber || item.day,
                topic: item.title, 
                objective: item.objective || ""
            };

            console.log(`   > Đang RAG bài Ngày ${currentItem.day}: ${currentItem.topic}`);

            try {
                const detail = await planService.generateScientificLesson(
                    plan._id,
                    currentItem,
                    learnerId,
                    previousTopics,
                    usedChunkSignatures,
                    learningGoals
                );
                
                previousTopics.push(currentItem.topic);
                if (Array.isArray(detail.usedChunkSignatures)) {
                    usedChunkSignatures.push(...detail.usedChunkSignatures);
                }

                await Lesson.create({
                    planId: plan._id,
                    dayNumber: currentItem.day,
                    title: currentItem.topic,
                    content: detail.content,
                    summary: detail.summary,
                    quiz: detail.quiz || [],
                    importantNotes: detail.importantNotes || [],
                    status: currentItem.day === 1 ? 'in-progress' : 'locked'
                });

                // Rate limiting
                if (currentItem.day < syllabus.length) {
                    await sleep(12000);
                }

            } catch (lessonError) {
                console.error(`   ❌ Lỗi tại bài ${currentItem.day}:`, lessonError.message);
                
                // Fallback lesson
                await Lesson.create({
                    planId: plan._id,
                    dayNumber: currentItem.day,
                    title: currentItem.topic,
                    content: "Nội dung bài học này đang gặp sự cố khởi tạo. Bạn có thể thử lại sau trong trang biên tập.",
                    summary: "Lỗi hệ thống AI",
                    quiz: [],
                    importantNotes: [],
                    status: 'locked'
                });
            }
        }

        console.log("✅ TẤT CẢ ĐÃ HOÀN TẤT");
        
        return res.status(200).json({
            success: true,
            message: "Lộ trình học tập đã sẵn sàng!",
            data: { 
                _id: plan._id,
                metadata: metadata // trả về để frontend có thể hiển thị stats
            }
        });

    } catch (error) {
        console.error("🔥 LỖI TỔNG QUAN TẠI CONTROLLER:", error.stack);
        return res.status(500).json({
            success: false,
            message: "Không thể khởi tạo khóa học: " + error.message
        });
    }
};

// ─────────────────────────────────────────────
// EXISTING FUNCTIONS (giữ nguyên)
// ─────────────────────────────────────────────

const getMyPlans = async (req, res) => {
    try {
        const plans = await Plan.find({ owner: req.user.id, isDeleted: false });
        return res.success(plans);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

const getPlanDetails = async (req, res) => {
    try {
        const plan = await Plan.findById(req.params.id).populate('documentId');
        const lessons = await Lesson.find({ 
            planId: req.params.id, 
            isDeleted: false 
        }).sort({ dayNumber: 1 });
        
        return res.success({ plan, lessons });
    } catch (error) {
        return res.error(error.message, 500);
    }
};

const getLessonDetail = async (req, res) => {
    try {
        const lesson = await Lesson.findOne({ 
            planId: req.params.id, 
            dayNumber: req.params.dayNumber 
        });
        return res.success(lesson);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

const deletePlan = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const plan = await Plan.findOne({ _id: id, owner: userId });
        if (!plan) {
            return res.status(404).json({ 
                success: false, 
                message: "Không tìm thấy lộ trình hoặc bạn không có quyền xóa." 
            });
        }

        console.log(`🗑️ Đang xóa lộ trình: ${id}`);

        // Xóa cascade
        await Lesson.deleteMany({ planId: id });
        await Chunk.deleteMany({ planId: id });
        await Enrollment.deleteMany({ planId: id });
        await Assignment.deleteMany({ planId: id });
        await Plan.findByIdAndDelete(id);

        console.log("✅ Đã dọn dẹp sạch sẽ dữ liệu của lộ trình.");

        return res.status(200).json({
            success: true,
            message: "Đã xóa lộ trình và các dữ liệu liên quan thành công."
        });

    } catch (error) {
        console.error("🔥 Lỗi khi xóa lộ trình:", error.message);
        return res.status(500).json({
            success: false,
            message: "Lỗi hệ thống: " + error.message
        });
    }
};

const sharePlan = async (req, res) => {
    try {
        const plan = await Plan.findByIdAndUpdate(
            req.params.id, 
            { isPublic: true }, 
            { new: true }
        );
        return res.success(plan, "Đã chia sẻ lộ trình.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

const updateInstructor = async (req, res) => {
    try {
        const { id } = req.params;
        const { instructorId } = req.body;

        const plan = await Plan.findByIdAndUpdate(
            id, 
            { instructorId }, 
            { new: true }
        );
        
        await Enrollment.findOneAndUpdate(
            { learnerId: req.user.id, planId: id },
            { instructorId, status: "pending" },
            { upsert: true }
        );

        return res.success(plan, "Đã cập nhật người hướng dẫn.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
    uploadAndExtract,     // ✅ NEW function
    processAndAnalyze,    // ✅ Updated with metadata
    finalizeCreateCourse, // ✅ Updated with metadata
    getMyPlans,
    getPlanDetails,
    getLessonDetail,
    deletePlan,
    updateInstructor,
    sharePlan
};
