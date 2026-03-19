const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { generateEmbedding } = require("./embeddingService");
const { searchRelevantChunks } = require("./vectorSearchService");
const Chunk = require("../models/Chunk");
const { chunkText } = require("../utils/chunkText"); // Bạn cần hàm chia nhỏ text

// BƯỚC 1: Xử lý tài liệu thô, chunking và lưu vector
const processAndStoreDocument = async (planId, fullText) => {
    // 1. Sử dụng hàm chunkText xịn của bạn
    const chunkObjects = chunkText(fullText); 
    
    const chunkDocs = [];

    // 2. Lặp qua mảng object { index, content, wordCount }
    for (const chunkObj of chunkObjects) {
        console.log(`Đang tạo embedding cho chunk ${chunkObj.index}...`);
        
        // Tạo embedding từ nội dung (đã bao gồm cả phần Overlap của bạn)
        const embedding = await generateEmbedding(chunkObj.content);
        
        chunkDocs.push({
            planId,
            content: chunkObj.content, // Nội dung có gối đầu
            embedding,
            chunkIndex: chunkObj.index,
            metadata: {
                wordCount: chunkObj.wordCount
            }
        });
    }

    // 3. Lưu vào MongoDB
    await Chunk.insertMany(chunkDocs);
    console.log(`Đã lưu ${chunkDocs.length} chunks vào Vector DB.`);
};
// BƯỚC 2: Phân tích sơ bộ (vẫn dùng một phần text đầu để tiết kiệm token)
const analyzeDocument = async (text) => {
    const promptAnalysis = `Dựa trên tài liệu này, hãy đề xuất thông số khóa học: "${text.substring(0, 5000)}"
    Trả về JSON: {
        "suggestedTitle": "Tiêu đề", "difficulty": "Medium", "suggestedDays": 7, "summary": "..."
    }`;

    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptAnalysis }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });
    
    const analysis = JSON.parse(res.choices[0].message.content);

    // Tạo preview plan
    const promptPreview = `Chia lộ trình học ${analysis.suggestedDays} ngày cho tiêu đề: ${analysis.suggestedTitle}. 
    Chỉ trả về JSON: {"plan": [{"dayNumber": 1, "title": "..."}, ...]}`;

    const resPreview = await groq.chat.completions.create({
        messages: [{ role: "user", content: promptPreview }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });

    return { analysis, previewPlan: JSON.parse(resPreview.choices[0].message.content).plan };
};

// BƯỚC 3: RAG thực thụ - Tạo nội dung bài học dựa trên Vector Search
const generateSingleLessonContent = async (planId, dayInfo) => {
    // Tìm context liên quan
    const queryVector = await generateEmbedding(dayInfo.title);
    const context = await searchRelevantChunks(planId, queryVector, 3);

    const prompt = `Bạn là một chuyên gia giáo dục. Dựa trên tài liệu hỗ trợ dưới đây (có thể bao gồm các đoạn nối tiếp nhau):
    ---
    ${context}
    ---
    Hãy soạn thảo bài học chi tiết: "Ngày ${dayInfo.dayNumber}: ${dayInfo.title}".
    
    YÊU CẦU:
    1. Nội dung (content): Viết chi tiết, chuyên sâu theo định dạng Markdown. Nếu tài liệu có mã nguồn hoặc công thức, hãy giữ nguyên.
    2. Tóm tắt (summary): Tóm tắt ý chính trong 3-5 dòng.
    3. Trắc nghiệm (quiz): 3 câu hỏi kèm 4 lựa chọn, có đáp án đúng (index 0-3) và giải thích.

    Trả về JSON: { "content": "...", "summary": "...", "quiz": [...] }`;

    const res = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
    });

    return JSON.parse(res.choices[0].message.content);
};

module.exports = { 
    processAndStoreDocument, 
    analyzeDocument, 
    generateSingleLessonContent 
};