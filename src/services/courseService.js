const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const analyzeDocument = async (text) => {
    // 1. AI Phân tích thông số đề xuất
    const promptAnalysis = `Dựa trên tài liệu này, hãy đề xuất thông số khóa học: "${text.substring(0, 4000)}"
    Trả về JSON: {
        "suggestedTitle": "Tiêu đề khóa học phù hợp",
        "difficulty": "Easy" | "Medium" | "Hard",
        "suggestedDays": 7,
        "summary": "Mô tả ngắn gọn về những gì khóa học này mang lại"
    }`;

    const resAnalysis = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptAnalysis }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });
    
    const analysis = JSON.parse(resAnalysis.choices[0].message.content);

    // 2. AI Tạo danh sách tiêu đề preview cho số ngày đề xuất
    const promptPreview = `Hãy chia nội dung này thành lộ trình học trong ${analysis.suggestedDays} ngày. 
    Chỉ trả về danh sách tiêu đề ngắn gọn cho từng ngày.
    Trả về định dạng JSON: {"plan": [{"dayNumber": 1, "title": "..."}, {"dayNumber": 2, "title": "..."}]}`;

    const resPreview = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptPreview }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });

    const previewPlan = JSON.parse(resPreview.choices[0].message.content).plan;

    return { analysis, previewPlan };
};

const generateSingleLessonContent = async (fullText, dayInfo) => {
    // Tăng giới hạn đọc lên (ví dụ 50,000 ký tự thay vì 6,000)
    const context = fullText.substring(0, 50000); 

    const prompt = `Dựa trên tài liệu: "${context}", 
    hãy viết nội dung chi tiết cho bài học: "Ngày ${dayInfo.dayNumber}: ${dayInfo.title}".
    
    YÊU CẦU:
    1. Nội dung (content) phải chi tiết, chuyên sâu, không viết chung chung.
    2. Viết tóm tắt (summary) ngắn gọn.
    3. Tạo 3 câu hỏi trắc nghiệm (quiz) sát với nội dung vừa viết.
    
    Trả về JSON: {
        "content": "...", 
        "summary": "...", 
        "quiz": [{"question": "...", "options": ["...", "..."], "correctAnswer": 0, "explanation": "..."}]
    }`;

    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });

    return JSON.parse(res.choices[0].message.content);
};

// Thêm vào courseService.js
const generateDetailedLessons = async (text, days) => {
    const prompt = `Dựa trên nội dung: "${text.substring(0, 6000)}", hãy viết giáo trình chi tiết cho ${days} ngày.
    Yêu cầu mỗi ngày bao gồm: title, nội dung bài giảng chi tiết (content), tóm tắt (summary), và 3 câu hỏi trắc nghiệm (quiz).
    Trả về JSON duy nhất: {"lessons": [{"dayNumber": 1, "title": "...", "content": "...", "summary": "...", "quiz": [...]}]}`;

    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });

    return JSON.parse(res.choices[0].message.content).lessons;
};

module.exports = { analyzeDocument, generateSingleLessonContent, generateDetailedLessons };