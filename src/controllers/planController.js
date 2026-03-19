const Plan = require("../models/Plan");
const Lesson = require("../models/Lesson");
const Groq = require("groq-sdk");
const courseService = require("../services/courseService"); // ĐÚNG // Import service RAG
// Khởi tạo Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Tạo lộ trình học từ văn bản bằng AI Groq
 */
const createPlanFromText = async (req, res) => {
  try {
    const { title, extractedText, numDays } = req.body;
    const userId = req.user?.id || req.user?._id;



 // --- BỔ SUNG GIỚI HẠN TẠI ĐÂY ---
    const MAX_DAYS = 14; // Bạn có thể chỉnh thành 7 hoặc 10 tùy ý
    const MIN_DAYS = 1;

    // Ép kiểu về số nguyên
    numDays = parseInt(numDays) || 7; 

    if (numDays > MAX_DAYS) {
        return res.status(400).json({ 
            success: false, 
            message: `Số ngày học quá dài. Vui lòng chọn tối đa ${MAX_DAYS} ngày.` 
        });
    }

    if (numDays < MIN_DAYS) numDays = MIN_DAYS;
    // -------------------------------








    if (!extractedText) return res.error("Văn bản đầu vào không được để trống", 400);

    // BƯỚC 1: Tạo bản ghi Plan tổng quan
    const newPlan = await Plan.create({
      title: title || "Khóa học mới",
      owner: userId,
      duration: numDays 
    });

    // BƯỚC 2: CHUNKING & EMBEDDING (RAG starts here)
    // Chia nhỏ text và lưu vector vào MongoDB Atlas dùng Gemini
    console.log("--- Đang xử lý Chunking và Embedding... ---");
    await courseService.processAndStoreDocument(newPlan._id, extractedText);

    // BƯỚC 3: Tạo dàn ý (Outline) cho các ngày học
    // AI chỉ cần tạo Tiêu đề cho từng ngày, chưa cần viết nội dung chi tiết ngay
    console.log("--- Đang tạo dàn ý lộ trình... ---");
    const { previewPlan } = await courseService.analyzeDocument(extractedText.substring(0, 5000));

    // BƯỚC 4: Tạo nội dung chi tiết từng ngày bằng Vector Search
    const lessonsToSave = [];
    
    for (const item of previewPlan) {
      console.log(`--- Đang viết nội dung RAG cho Ngày ${item.dayNumber}: ${item.title} ---`);
      
      // Hàm này sẽ dùng Vector Search để tìm nội dung liên quan nhất cho ngày này
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

    // BƯỚC 5: Lưu toàn bộ bài học vào Database
    await Lesson.insertMany(lessonsToSave);

    return res.success({ _id: newPlan._id }, "Đã tạo lộ trình học tập RAG thành công!");

  } catch (error) {
    console.error("LỖI HỆ THỐNG RAG:", error.message);
    return res.error("Lỗi khi tạo lộ trình: " + error.message, 500);
  }
};

/**
 * Lấy toàn bộ danh sách bài học của một Plan
 */
const getPlanDetails = async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return res.error("Không tìm thấy lộ trình", 404);

    const lessons = await Lesson.find({ planId: req.params.id }).sort({ dayNumber: 1 });
    
    return res.success({ plan, lessons }, "Lấy dữ liệu lộ trình thành công");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * Lấy chi tiết nội dung của một bài học cụ thể trong ngày
 */
const getLessonDetail = async (req, res) => {
  try {
    const { id, dayNumber } = req.params;
    const lesson = await Lesson.findOne({ planId: id, dayNumber: dayNumber });
    
    if (!lesson) return res.error("Không tìm thấy nội dung bài học cho ngày này", 404);
    
    return res.success(lesson, "Lấy chi tiết bài học thành công");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// Xuất khẩu toàn bộ 3 hàm
module.exports = { 
  createPlanFromText, 
  getPlanDetails, 
  getLessonDetail 
};