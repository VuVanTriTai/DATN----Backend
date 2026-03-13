const Plan = require("../models/Plan");
const Lesson = require("../models/Lesson");
const Groq = require("groq-sdk");

// Khởi tạo Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Tạo lộ trình học từ văn bản bằng AI Groq
 */
const createPlanFromText = async (req, res) => {
  try {
    const { title, extractedText, numDays } = req.body;
    const userId = req.user?.id || req.user?._id;

    if (!extractedText) return res.error("Văn bản đầu vào không được để trống", 400);

    // 1. Tạo bản ghi Plan (Lưu thông tin tổng quan)
    const newPlan = await Plan.create({
      title: title || "Khóa học mới",
      owner: userId,
      duration: numDays || 7
    });

    // 2. Prompt yêu cầu AI chia nhỏ bài học
    const prompt = `Bạn là chuyên gia giáo dục. Dựa trên nội dung: "${extractedText.substring(0, 4000)}", 
    hãy chia thành lộ trình học ${numDays || 7} ngày.
    
    YÊU CẦU ĐỊNH DẠNG JSON BẮT BUỘC:
    {
      "lessons": [
        {
          "dayNumber": 1,
          "title": "Tiêu đề bài học",
          "content": "Nội dung bài học chi tiết",
          "summary": "Tóm tắt ngắn",
          "quiz": [
            {
              "question": "Câu hỏi?",
              "options": ["A", "B", "C", "D"],
              "correctAnswer": 0,
              "explanation": "Giải thích"
            }
          ]
        }
      ]
    }
    Lưu ý: "quiz" luôn phải là một MẢNG (Array). Nếu không có câu hỏi hãy để []`;

    // 3. Gọi Groq Llama 3.3
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "Bạn là chuyên gia tạo giáo án, luôn trả về JSON." },
        { role: "user", content: prompt }
      ],
      model: "llama-3.3-70b-versatile", 
      temperature: 0.2,
      response_format: { type: "json_object" }
    });

    const aiData = JSON.parse(chatCompletion.choices[0].message.content);

    // 4. Xử lý và làm sạch dữ liệu trước khi lưu vào DB (Fix lỗi validation quiz)
    const lessonsToSave = aiData.lessons.map(lesson => {
      // Đảm bảo quiz luôn là mảng để không lỗi Schema
      let sanitizedQuiz = [];
      if (Array.isArray(lesson.quiz)) {
        sanitizedQuiz = lesson.quiz.filter(q => typeof q === 'object' && q.question);
      }

      return {
        planId: newPlan._id,
        dayNumber: lesson.dayNumber,
        title: lesson.title,
        content: lesson.content,
        summary: lesson.summary,
        quiz: sanitizedQuiz,
        status: lesson.dayNumber === 1 ? 'in-progress' : 'locked'
      };
    });

    await Lesson.insertMany(lessonsToSave);

    return res.success({ _id: newPlan._id }, "Đã tạo lộ trình học tập thành công!");

  } catch (error) {
    console.error("LỖI HỆ THỐNG AI:", error.message);
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