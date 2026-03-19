const { extractTextFromFile } = require('../utils/extractText');
const courseService = require('../services/courseService'); // Sửa lại path cho đúng
const Plan = require('../models/Plan');
const Lesson = require('../models/Lesson');

/**
 * BƯỚC 1: Upload và Phân tích sơ bộ (Hiện trang Review)
 */
// controllers/courseController.js

// Hàm tạo độ trễ để tránh lỗi Rate Limit (429) của Groq
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

const generatePreviewPlan = async (text, days) => {
    const promptPreview = `Dựa trên nội dung: "${text.substring(0, 5000)}", hãy chia lại lộ trình thành ĐÚNG ${days} ngày.
    Chỉ trả về JSON: {"plan": [{"dayNumber": 1, "title": "..."}, ...]}`;

    const resPreview = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptPreview }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });

    return JSON.parse(resPreview.choices[0].message.content).plan;
};
const finalizeCreateCourse = async (req, res) => {
    try {
        const { title, extractedText, numDays } = req.body;
        const userId = req.user.id;

        if (!extractedText) return res.error("Không có nội dung văn bản để xử lý", 400);

        console.log("--- BẮT ĐẦU QUY TRÌNH TẠO KHÓA HỌC TỰ ĐỘNG ---");

        // BƯỚC 1: Khởi tạo Plan nháp
        const newPlan = await Plan.create({
            title: title || "Đang xử lý...",
            owner: userId,
            duration: numDays
        });

        // BƯỚC 2: Chunking & Embedding (Lưu vào Vector DB - 1024 dim)
        // Bước này chạy Local nên rất nhanh và không tốn Token AI
        console.log("1. Đang xử lý Embedding...");
        await courseService.processAndStoreDocument(newPlan._id, extractedText);

        // BƯỚC 3: AI Thiết kế Syllabus (Dàn ý khoa học)
        console.log("2. AI đang thiết kế giáo trình...");
        const syllabusData = await courseService.generateSyllabus(extractedText, numDays);
        
        // Cập nhật lại tiêu đề thật mà AI đề xuất
        newPlan.title = syllabusData.title;
        await newPlan.save();

        // BƯỚC 4: Vòng lặp tạo nội dung chi tiết cho từng ngày (RAG)
        console.log(`3. Bắt đầu tạo chi tiết ${numDays} bài học...`);
        
        for (const item of syllabusData.syllabus) {
            console.log(`> Đang tạo bài Ngày ${item.day}: ${item.topic}`);
            
            try {
                // Gọi AI tạo nội dung & Quiz dựa trên Context (RAG)
                const detail = await courseService.generateScientificLesson(newPlan._id, item);
                
                // Lưu từng bài học vào DB ngay lập tức để tránh mất dữ liệu nếu lỗi giữa chừng
                await Lesson.create({
                    planId: newPlan._id,
                    dayNumber: item.day,
                    title: item.topic,
                    content: detail.content,
                    summary: detail.summary,
                    quiz: detail.quiz || [],
                    status: item.day === 1 ? 'in-progress' : 'locked'
                });

                // NGHỈ ĐỂ TRÁNH RATE LIMIT (Gói miễn phí cần nghỉ khoảng 10-15 giây)
                if (item.day < syllabusData.syllabus.length) {
                    console.log(`   - Hoàn tất bài ${item.day}. Nghỉ 12 giây để hồi Token...`);
                    await sleep(12000); 
                }

            } catch (lessonError) {
                console.error(`❌ Lỗi tại bài ${item.day}:`, lessonError.message);
                // Tạo bài học lỗi làm dự phòng (Fallback)
                await Lesson.create({
                    planId: newPlan._id,
                    dayNumber: item.day,
                    title: item.topic,
                    content: "Nội dung bài học này gặp sự cố khi tạo tự động. Bạn có thể nhấn nút 'Tạo lại' trong trang biên tập.",
                    summary: "Lỗi AI",
                    quiz: [],
                    status: 'locked'
                });
            }
        }

        console.log("--- ✅ TẤT CẢ ĐÃ HOÀN TẤT ---");
        return res.success({ _id: newPlan._id }, "Khóa học RAG đã được tạo thành công!");

    } catch (error) {
        console.error("🔥 LỖI TỔNG QUAN:", error);
        return res.error(error.message, 500);
    }
};
module.exports = { 
    generatePreviewPlan,
    processAndAnalyze, 
    regeneratePreview,
    finalizeCreateCourse 
};