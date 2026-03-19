const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks } = require("./vectorSearchService");
const Chunk = require("../models/Chunk");
const { chunkText } = require("../utils/chunkText"); 
const { cleanText } = require("../utils/cleanText"); 


/**
 * HÀM CHÍNH: Tự động hóa hoàn toàn việc tạo Khóa học & Quiz khoa học
 */
const generateFullAutoCourse = async (planId, rawText, numDays) => {
    // 1. Làm sạch văn bản
    const cleanedText = cleanText(rawText);

    // 2. AI Thiết kế Syllabus (Dàn ý khoa học)
    // Chúng ta gửi khoảng 15.000 ký tự đầu để AI nắm tổng quan
    const syllabusPrompt = `Bạn là Chuyên gia sư phạm cao cấp. 
    NHIỆM VỤ: Dựa vào tài liệu, hãy thiết kế một lộ trình học tập KHOA HỌC trong ${numDays} ngày.
    YÊU CẦU:
    - Phân bổ kiến thức từ cơ bản đến chuyên sâu (Bloom's Taxonomy).
    - Trả về JSON: {"title": "Tên khóa học", "syllabus": [{"day": 1, "topic": "Tiêu đề bài", "objective": "Mục tiêu bài"}]}`;

    const syllabusRes = await groq.chat.completions.create({
        messages: [{ role: "user", content: syllabusPrompt + "\n\nDocument: " + cleanedText.substring(0, 15000) }],
        model: "llama-3.1-8b-instant",
        response_format: { type: "json_object" }
    });
    const syllabus = JSON.parse(syllabusRes.choices[0].message.content);

    // 3. Thực hiện Chunking & Embedding (Dùng để RAG cho từng bài)
    // Chỉnh sửa chunkText của bạn để dùng MAX_WORDS = 350 (theo tài liệu)
    await processAndStoreDocument(planId, cleanedText);

    // 4. Tự động tạo nội dung & Quiz cho từng bài (Loop)
    const lessons = [];
    for (const item of syllabus.syllabus) {
        console.log(`--- Đang tự động khai thác nội dung cho: ${item.topic} ---`);
        const lessonDetail = await generateScientificLesson(planId, item);
        lessons.push({
            planId: planId,
            dayNumber: item.day,
            title: item.topic,
            content: lessonDetail.content,
            summary: lessonDetail.summary,
            quiz: lessonDetail.quiz,
            status: item.day === 1 ? 'in-progress' : 'locked'
        });
    }
    return { title: syllabus.title, lessons };
};







/**
 * Sinh bài giảng & Quiz theo 4 mức độ tư duy (Scientific Quiz)
 */
const generateScientificLesson = async (planId, item) => {
    const queryVector = await generateEmbedding(item.topic + " " + item.objective);
    const context = await searchRelevantChunks(planId, queryVector, 6);

    // Prompt siêu nghiêm ngặt để ép AI không sinh key lạ
    const prompt = `Bạn là robot soạn bài giảng. Dựa trên tài liệu:
    ---
    ${context}
    ---
    NHIỆM VỤ: Viết bài học cho: ${item.topic}.

    YÊU CẦU BẮT BUỘC:
    1. CHỈ TRẢ VỀ JSON với đúng 3 key: "content", "summary", "quiz". 
    2. KHÔNG TỰ Ý tạo thêm bất kỳ key nào khác (như "mục tiêu", "chuẩn bị"...).
    3. Toàn bộ nội dung giảng dạy, mục tiêu, chuẩn bị... PHẢI nằm hết bên trong key "content" dưới dạng Markdown.
    4. "quiz" là mảng gồm 3 câu hỏi.

    CẤU TRÚC JSON MẪU:
    {
        "content": "# Tiêu đề\\n## Mục tiêu\\n...nội dung chi tiết...",
        "summary": "...",
        "quiz": [{"question": "...", "options": ["..."], "correctAnswer": 0, "level": "Nhận biết"}]
    }`;

    const res = await groq.chat.completions.create({
        messages: [
            { role: "system", content: "Bạn là máy phát JSON. Chỉ trả về JSON thuần túy, không thêm text ngoài, không thêm key ngoài cấu trúc mẫu." },
            { role: "user", content: prompt }
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0.1, // Thấp nhất để AI không sáng tạo bậy
        response_format: { type: "json_object" }
    });
    return JSON.parse(res.choices[0].message.content);
};






const generateSyllabus = async (rawText, numDays) => {
    const syllabusPrompt = `Bạn là Chuyên gia sư phạm. Dựa trên tài liệu này, hãy thiết kế lộ trình học ${numDays} ngày.
    YÊU CẦU: Kiến thức đi từ cơ bản đến nâng cao. 
    BẮT BUỘC TRẢ VỀ JSON: {"title": "Tên khóa học", "syllabus": [{"day": 1, "topic": "Tên bài", "goal": "Mục tiêu"}]}`;

    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: syllabusPrompt + "\n\nTEXT: " + rawText.substring(0, 10000) }],
        model: "llama-3.1-8b-instant",
        response_format: { type: "json_object" }
    });
    return JSON.parse(res.choices[0].message.content);
};




/**
 * BƯỚC 1: Xử lý tài liệu thô, chunking và lưu vector vào MongoDB Atlas
 */
const processAndStoreDocument = async (planId, fullText) => {
    // 1. Sử dụng hàm chunkText xịn (trả về mảng các object {index, content, wordCount})
    const chunkObjects = chunkText(fullText); 
    const chunkDocs = [];

    // 2. Lặp tuần tự để tránh lỗi Rate Limit của API Embedding
    for (const chunkObj of chunkObjects) {
        console.log(`Đang tạo embedding cho chunk ${chunkObj.index}...`);
        try {
            const embedding = await generateEmbedding(chunkObj.content);
            
            chunkDocs.push({
                planId,
                content: chunkObj.content,
                embedding,
                chunkIndex: chunkObj.index,
                metadata: {
                    wordCount: chunkObj.wordCount
                }
            });
        } catch (error) {
            console.error(`Lỗi tạo embedding tại chunk ${chunkObj.index}:`, error.message);
        }
    }

    // 3. Lưu toàn bộ vào MongoDB
    if (chunkDocs.length > 0) {
        await Chunk.insertMany(chunkDocs);
        console.log(`✅ Đã lưu thành công ${chunkDocs.length} chunks vào Vector DB.`);
    }
};

/**
 * BƯỚC 2: Phân tích sơ bộ tài liệu (Dùng để hiển thị trang Review)
 */
const analyzeDocument = async (text) => {
    // 1. Phân tích thông số
    const promptAnalysis = `BẠN LÀ MỘT CÔNG CỤ TRÍCH XUẤT DỮ LIỆU. 
    NHIỆM VỤ: Đọc tài liệu sau và đề xuất thông số khóa học.
    BẮT BUỘC: CHỈ SỬ DỤNG NỘI DUNG TRONG TÀI LIỆU ĐỂ TẠO TIÊU ĐỀ VÀ TÓM TẮT. KHÔNG TỰ Ý SÁNG TẠO KIẾN THỨC BÊN NGOÀI.
    
    TÀI LIỆU: "${text.substring(0, 5000)}"

    Trả về JSON: {
        "suggestedTitle": "Tiêu đề dựa hoàn toàn trên tài liệu",
        "difficulty": "Easy" | "Medium" | "Hard",
        "suggestedDays": 7, 
        "summary": "Tóm tắt ngắn gọn những gì tài liệu này nói"
    }`;

    const resAnalysis = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptAnalysis }],
        model: "llama-3.1-8b-instant", // Dùng 8b cho nhanh và ổn định
        response_format: { type: "json_object" }
    });
    
    // SỬA LỖI: res -> resAnalysis
    const analysis = JSON.parse(resAnalysis.choices[0].message.content);

    // 2. Tạo dàn ý (Preview Plan)
    // SỬA LỖI: numDays -> analysis.suggestedDays
     // 2. Tạo dàn ý (Preview Plan) - ÉP AI SỬ DỤNG TÀI LIỆU
    const promptPreview = `Dựa trên tài liệu đã cung cấp, hãy chia lộ trình học thành ĐÚNG ${analysis.suggestedDays} ngày.
    CẢNH BÁO: Mỗi tiêu đề bài học phải liên quan trực tiếp đến các chương/mục trong tài liệu báo cáo thực tập.
    Trả về JSON: {"plan": [{"dayNumber": 1, "title": "..."}, ...]}`;



    const resPreview = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptPreview }],
        model: "llama-3.1-8b-instant",
        response_format: { type: "json_object" }
    });

    const previewPlan = JSON.parse(resPreview.choices[0].message.content).plan;

    // Trả về dữ liệu sạch cho Frontend
    return { analysis, previewPlan };
};





// HÀM CHIA LẠI NGÀY (Cần để sửa lỗi đổi ngày từ 14 -> 7)
const generatePreviewPlan = async (text, days) => {
    const prompt = `Bạn là chuyên gia phân tích tài liệu. 
    TÀI LIỆU: "${text.substring(0, 5000)}"
    NHIỆM VỤ: Chia tài liệu trên thành lộ trình ĐÚNG ${days} ngày.
    YÊU CẦU: Chỉ lấy tiêu đề có trong tài liệu.
    Trả về JSON: {"plan": [{"dayNumber": 1, "title": "..."}, ...]}`;

    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.1-8b-instant",
        response_format: { type: "json_object" }
    });

    return JSON.parse(res.choices[0].message.content).plan;
};


/**
 * BƯỚC 3: RAG thực thụ - Tạo nội dung chi tiết bài học dựa trên kết quả tìm kiếm Vector
 */
const generateSingleLessonContent = async (planId, dayInfo) => {
    try {
        const queryVector = await generateEmbedding(dayInfo.title);
        
        // Thêm try/catch cho phần search
        let context = "";
        try {
            context = await searchRelevantChunks(planId, queryVector, 5);
        } catch (searchErr) {
            console.warn("⚠️ Không tìm thấy context từ Vector Search, dùng bài học rỗng.");
            context = "Không có tài liệu bổ trợ cho phần này.";
        }
    // 2. Gửi Prompt kèm ngữ cảnh (Context) cho Groq
    
    // Cải tiến Prompt: Yêu cầu cực kỳ khắt khe về JSON
    const prompt = `BẠN LÀ MỘT CỖ MÁY TRÍCH XUẤT THÔNG TIN. 
NHIỆM VỤ: Viết nội dung bài học dựa TRÊN TÀI LIỆU được cung cấp bên dưới:
    
--- TÀI LIỆU HỖ TRỢ ---

    ---
    ${context}
    ---
    YÊU CẦU NGHIÊM NGẶT:
    - Hãy soạn bài học: "Ngày ${dayInfo.dayNumber}: ${dayInfo.title}".
    - Nội dung phải hoàn toàn dựa trên tài liệu hỗ trợ, KHÔNG SÁNG TẠO KIẾN THỨC BÊN NGOÀI.
    
    - Trả về DUY NHẤT một đối tượng JSON.
    - KHÔNG bao bọc JSON trong ký tự markdown \`\`\`json.
    - Các dấu xuống dòng trong nội dung bài học phải được viết là \\n.
    - Đảm bảo trắc nghiệm (quiz) là một mảng có đúng 3 câu hỏi.

    CẤU TRÚC JSON MẪU:
    {
        "content": "Nội dung bài giảng chi tiết bằng Markdown...",
        "summary": "Tóm tắt ngắn gọn...",
        "quiz": [
            {
                "question": "Câu hỏi 1?",
                "options": ["A", "B", "C", "D"],
                "correctAnswer": 0,
                "explanation": "Giải thích tại sao A đúng..."
            }
        ]
    }`;

    const res = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "llama-3.1-8b-instant", // Ưu tiên dùng bản 8b để tránh lỗi 429 Rate Limit
            response_format: { type: "json_object" }
        });

        return JSON.parse(res.choices[0].message.content);
    } catch (err) {
        throw err;
    }
};
module.exports = { 
    processAndStoreDocument, 
    analyzeDocument, 
    generateSingleLessonContent,
    generatePreviewPlan,
    generateScientificLesson,
     generateFullAutoCourse,
        generateSyllabus 
};