// services/aiService.js
const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks } = require("./vectorSearchService");

/**
 * Generate lesson metadata: summary, importantNotes, quiz
 * Được gọi từ planService Phase 2
 */
const generateLessonMeta = async (params) => {
    const {
        searchTopic,
        context,
        objective,
        bloomLevel,
        quizBounds,
        profile,
        formulaNotes,
        totalDays,
    } = params;

    if (!context || context.length < 50) {
        console.warn(`⚠️ [Meta] RAG context rỗng cho bài: ${searchTopic}`);
        return JSON.stringify({
            summary: objective || `Tổng quan về ${searchTopic}`,
            importantNotes: formulaNotes || [],
            quiz: [],
        });
    }

    const minQuiz = quizBounds?.min || 3;
    const maxQuiz = quizBounds?.max || 5;
    const focusNote = profile?.focus === "practice"
        ? "Ưu tiên câu hỏi thực hành, ví dụ cụ thể."
        : "Ưu tiên câu hỏi lý thuyết, định nghĩa, so sánh.";

    const prompt = `Bạn là chuyên gia giáo dục. Phân tích bài học và tạo metadata.

CHỦ ĐỀ: ${searchTopic}
MỤC TIÊU: ${objective || searchTopic}
BLOOM: ${bloomLevel}
${focusNote}

CONTEXT:
${context.substring(0, 3500)}

TRẢ VỀ JSON:
{
  "summary": "1-2 câu tóm tắt nội dung chính",
  "importantNotes": ["ghi chú quan trọng 1", "ghi chú quan trọng 2"],
  "quiz": [
    {
      "question": "Câu hỏi?",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": 0,
      "explanation": "Giải thích tại sao đúng"
    }
  ]
}

YÊU CẦU QUIZ:
- Tạo ${minQuiz}-${maxQuiz} câu hỏi trắc nghiệm 4 đáp án
- Chỉ hỏi về nội dung có trong CONTEXT
- Không ghi "Đúng:" hoặc "Sai:" trong đáp án
- correctAnswer là index 0-3`;

    try {
        const { makeGroqRequest } = require("./planService");
        const resText = await makeGroqRequest({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: "Chỉ trả về JSON hợp lệ." },
                { role: "user", content: prompt },
            ],
            enforceJSON: true,
            temperature: 0.2,
        });

        return resText;

    } catch (error) {
        if (/429|rate|timeout/i.test(error.message)) throw error;

        console.error("❌ [Meta] Error:", error.message);
        return JSON.stringify({
            summary: objective || `Tổng quan về ${searchTopic}`,
            importantNotes: formulaNotes || [],
            quiz: [],
        });
    }
};

/**
 * Chat với tài liệu dựa trên RAG
 */
const chatWithDocument = async (question, planId) => {
    const queryVector = await generateEmbedding(question);
    const chunks = await searchRelevantChunks(planId, queryVector, 5);

    // ✅ Fix: join chunks thành string
    const context = Array.isArray(chunks)
        ? chunks.map(c => c.content || "").join("\n---\n")
        : String(chunks || "");

    const prompt = `Bạn là trợ lý học tập thông minh.
Dựa vào ngữ cảnh dưới đây để trả lời câu hỏi. 
Nếu thông tin không có trong ngữ cảnh, hãy nói "Tôi không tìm thấy thông tin này trong tài liệu".

NGỮ CẢNH:
${context}

CÂU HỎI: ${question}`;

    const { makeGroqPlainRequest } = require("./planService");
    return makeGroqPlainRequest({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.1-8b-instant",
    });
};

/**
 * AI chấm bài tự động dựa trên đáp án của người hướng dẫn
 */
const gradeAssignmentByAI = async (studentSubmission, instructorSolution, lessonTheory) => {
    try {
        const prompt = `Bạn là một giảng viên đang chấm bài tập cho học viên.

- LÝ THUYẾT BÀI HỌC (chỉ để tham khảo):
${lessonTheory || "Không có"}

- ĐÁP ÁN CHUẨN TỪ NGƯỜI HƯỚNG DẪN:
${instructorSolution}

- BÀI LÀM CỦA HỌC VIÊN:
${studentSubmission}

YÊU CẦU:
1. Chỉ chấm dựa trên đối chiếu bài làm và đáp án chuẩn.
2. Nếu bài làm chứa thông báo lỗi không đọc được file → cho 0 điểm, nhận xét yêu cầu nộp lại.
3. Tìm điểm đúng, sai, thiếu sót so với đáp án.
4. Thang điểm 10 (có thể cho điểm lẻ như 8.5).

TRẢ VỀ JSON:
{
  "score": <0-10>,
  "feedback": "<nhận xét chi tiết>"
}`;

        const { makeGroqRequest } = require("./planService");
        return makeGroqRequest({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: "Chỉ trả về JSON chuẩn." },
                { role: "user", content: prompt },
            ],
            enforceJSON: true,
            temperature: 0.1,
        });

    } catch (error) {
        console.error("❌ [AI Grading] Error:", error.message);
        throw error;
    }
};

module.exports = { chatWithDocument, generateLessonMeta, gradeAssignmentByAI };