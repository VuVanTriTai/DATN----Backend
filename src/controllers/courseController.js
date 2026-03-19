const { extractTextFromFile } = require('../utils/extractText');
const courseService = require('../services/courseService'); // Sửa lại path cho đúng
const Plan = require('../models/Plan');
const Lesson = require('../models/Lesson');

/**
 * BƯỚC 1: Upload và Phân tích sơ bộ (Hiện trang Review)
 */
// controllers/courseController.js

const processAndAnalyze = async (req, res) => {
    try {
        // Lấy text từ body (vì Frontend gửi { text: ... })
        const { text } = req.body; 

        if (!text) {
            return res.status(400).json({ 
                success: "false", 
                message: "Không nhận được văn bản để phân tích." 
            });
        }

        // Gọi service AI để phân tích văn bản thô
        // (Lưu ý: Truyền thẳng 'text' vào hàm analyzeDocument)
        const result = await courseService.analyzeDocument(text);

        return res.success({
            rawText: text, // Gửi lại text để Frontend lưu vào state
            analysis: result.analysis,
            previewPlan: result.previewPlan
        }, "Phân tích tài liệu thành công.");

    } catch (error) {
        console.error("Lỗi Controller Analyze:", error);
        return res.error(error.message, 500);
    }
};

/**
 * BƯỚC 2: Chia lại lộ trình khi User đổi số ngày (Instant Refresh)
 */
const regeneratePreview = async (req, res) => {
    try {
        const { rawText, days } = req.body;
        if (!rawText || !days) return res.error("Thiếu văn bản hoặc số ngày", 400);

        // Gọi AI chia lại tiêu đề (rất nhanh vì không tạo nội dung chi tiết)
        const newPlan = await courseService.generatePreviewPlan(rawText, days);
        
        return res.success(newPlan, "Đã cập nhật lộ trình xem trước.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * BƯỚC 3: Xác nhận tạo khóa học thật sự vào Database
 */
const finalizeCreateCourse = async (req, res) => {
    try {
        const { title, extractedText, numDays, difficulty, previewPlan } = req.body;
        const userId = req.user.id;

        // 1. Tạo Plan (Course)
        const newPlan = await Plan.create({
            title: title,
            owner: userId,
            duration: numDays,
            level: difficulty
        });

        // 2. CHUNKING & EMBEDDING (Lưu vào Vector DB)
        // Đây là bước quan trọng nhất để kích hoạt RAG
        await courseService.processAndStoreDocument(newPlan._id, extractedText);

        // 3. Tạo bài học bằng RAG (Vector Search từng bài)
        const lessonsToSave = [];
        for (const item of previewPlan) {
            // Truyền newPlan._id để AI tìm đúng các chunks của khóa học này
            const detail = await courseService.generateSingleLessonContent(newPlan._id, item);
            
            lessonsToSave.push({
                planId: newPlan._id,
                dayNumber: item.dayNumber,
                title: item.title,
                content: detail.content,
                summary: detail.summary,
                quiz: detail.quiz || [],
                status: item.dayNumber === 1 ? 'in-progress' : 'locked'
            });
        }

        await Lesson.insertMany(lessonsToSave);
        return res.success({ _id: newPlan._id }, "Khóa học RAG đã khởi tạo thành công!");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

module.exports = { 
    processAndAnalyze, 
    regeneratePreview,
    finalizeCreateCourse 
};