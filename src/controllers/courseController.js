// controllers/courseController.js
const planService = require('../services/planService');
console.log("🔥 planService keys:", Object.keys(planService));
const Plan = require('../models/Plan');
const Lesson = require('../models/Lesson');

// delay tránh rate limit
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
//const safeQuiz = Array.isArray(detail.quiz) ? detail.quiz : [];
const { updateUserMemory } = require("../services/userContextService");


/**
 * 
 * BƯỚC 1: Analyze (Review screen)
 */
const processAndAnalyze = async (req, res) => {
    try {
        const { text, learningGoals: rawGoals } = req.body;

        if (!text) {
            return res.status(400).json({
                success: false,
                message: "Không có văn bản"
            });
        }

        const result = await planService.analyzeDocument(text, rawGoals || {});

        return res.success({
            rawText: text,
            analysis: result.analysis,
            previewPlan: result.previewPlan
        });

    } catch (error) {
        console.error("❌ Analyze Error:", error.message);
        return res.error(error.message, 500);
    }
};


/**
 * BƯỚC 2: Regenerate preview (đổi số ngày)
 */
const regeneratePreview = async (req, res) => {
    try {
        const { rawText, days } = req.body;

        if (!rawText || !days) {
            return res.error("Thiếu dữ liệu", 400);
        }

        const newPlan = await planService.generatePreviewPlan(rawText, days);

        return res.success(newPlan);

    } catch (error) {
        return res.error(error.message, 500);
    }
};


/**
 * BƯỚC 3: Tạo khóa học thật (RAG FULL)
 */
const finalizeCreateCourse = async (req, res) => {
    try {
        const { title, extractedText, numDays } = req.body;
        const userId = req.user?.id || req.user?._id;

        if (!extractedText) {
            return res.error("Thiếu nội dung", 400);
        }

        console.log("🚀 START AUTO COURSE");

        // 1. Tạo plan
        const plan = await Plan.create({
            title: title || "Đang xử lý...",
            owner: userId,
            duration: numDays
        });

        // 2. Chunk + embedding
        console.log("📦 Embedding...");
        await planService.processAndStoreDocument(plan._id, extractedText);

        // 3. Generate syllabus (outline chuẩn)
        console.log("🧠 Generate syllabus...");
        const syllabusData = await planService.generateSyllabus(extractedText, numDays);

        plan.title = syllabusData.title;
        await plan.save();

        // 4. Generate lessons (RAG)
        console.log("📚 Generate lessons...");

        for (const item of syllabusData.syllabus) {
            console.log(`➡️ Day ${item.day}: ${item.topic}`);

    try {
        const detail = await planService.generateLesson(plan._id, {
        topic: item.topic,
        day: item.day,
        objective: item.objective || ""
        }, userId);
    const safeQuiz = Array.isArray(detail.quiz) ? detail.quiz : [];

        await Lesson.create({
            planId: plan._id,
            dayNumber: item.day,
            title: item.topic,
            content: detail.content || "",
            summary: detail.summary || "",
            quiz: safeQuiz,
            status: item.day === 1 ? 'in-progress' : 'locked'
        });

        // 🔥 CHÈN NGAY ĐÂY
        if (detail.content && detail.content.length > 50) {
            await updateUserMemory(userId, item.topic);
        }


        if (item.day < syllabusData.syllabus.length) {
            await sleep(10000);
        }

    } catch (err) {
        console.error(`❌ Lesson ${item.day} failed:`, err.message);

        await Lesson.create({
            planId: plan._id,
            dayNumber: item.day,
            title: item.topic,
            content: "Lỗi khi tạo nội dung. Có thể regenerate.",
            summary: "AI error",
            quiz: [],
            status: 'locked'
        });
    }
}

        console.log("✅ DONE");

        return res.success({
            _id: plan._id
        }, "Tạo khóa học thành công");

    } catch (error) {
        console.error("🔥 FINAL ERROR:", error);
        return res.error(error.message, 500);
    }
};
const getMyPlans = async (req, res) => {
  try {
    const plans = await Plan.find({ owner: req.user.id });
    res.success(plans);
  } catch (err) {
    res.error(err.message);
  }
};
const deletePlan = async (req, res) => {
  try {
    const planId = req.params.id;

    const plan = await Plan.findOne({
      _id: planId,
      owner: req.user.id,
      isDeleted: false
    });

    if (!plan) return res.error("Không tìm thấy plan", 404);

    // soft delete plan
    plan.isDeleted = true;
    plan.deleteAt = new Date();
    await plan.save();

    // soft delete lessons
    await Lesson.updateMany(
      { planId },
      { isDeleted: true, deleteAt: new Date() }
    );

    res.success(null, "Đã xóa (soft)");
  } catch (err) {
    res.error(err.message);
  }
};




module.exports = {
    processAndAnalyze,
    regeneratePreview,
    finalizeCreateCourse,
    getMyPlans,
    deletePlan
};