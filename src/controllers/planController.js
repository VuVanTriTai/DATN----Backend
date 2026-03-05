const Plan = require('../models/Plan');
const Lesson = require('../models/Lesson');
const OpenAI = require('openai');

const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
});

const createPlanFromText = async (req, res) => {
    try {
        const { title, extractedText, numDays } = req.body;
        const userId = req.user.id;

        // 1. Tạo bản ghi Plan trước
        const newPlan = await Plan.create({
            title,
            owner: userId,
            duration: numDays
        });

        // 2. Gọi AI để chia nhỏ văn bản thành bài học từng ngày
        const prompt = `
        Bạn là một trợ lý giáo dục. Tôi có văn bản sau đây: "${extractedText}"
        Hãy chia nhỏ văn bản này thành lộ trình học trong ${numDays} ngày.
        Với mỗi ngày, hãy cung cấp:
        1. Tiêu đề bài học.
        2. Nội dung chi tiết (khoảng 500 chữ).
        3. Bản tóm tắt ngắn gọn.
        4. 3 câu hỏi trắc nghiệm kèm đáp án và giải thích.

        Yêu cầu trả về DUY NHẤT định dạng JSON:
        {
          "lessons": [
            {
              "dayNumber": 1,
              "title": "...",
              "content": "...",
              "summary": "...",
              "quiz": [{"question": "...", "options": ["A", "B", "C", "D"], "correctAnswer": 0, "explanation": "..."}]
            }
          ]
        }`;

        const completion = await client.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        });

        const aiData = JSON.parse(completion.choices[0].message.content);

        // 3. Lưu danh sách bài học vào bảng Lesson
        const lessonsToSave = aiData.lessons.map(lesson => ({
            ...lesson,
            planId: newPlan._id,
            status: lesson.dayNumber === 1 ? 'in-progress' : 'locked'
        }));

        await Lesson.insertMany(lessonsToSave);

        return res.success({ planId: newPlan._id }, "Đã tạo lộ trình học tập thành công");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

const getPlanDetails = async (req, res) => {
    try {
        const plan = await Plan.findById(req.params.id);
        const lessons = await Lesson.find({ planId: req.params.id }).sort({ dayNumber: 1 });
        return res.success({ plan, lessons });
    } catch (error) {
        return res.error(error.message, 500);
    }
};

module.exports = { createPlanFromText, getPlanDetails };