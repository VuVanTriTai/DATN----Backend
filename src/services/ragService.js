// services/ragService.js
"use strict";

const { searchRelevantChunks, searchChunksBySection, searchRelevantChunksByTopic } = require('./vectorSearchService');
const { generateEmbedding } = require('./embeddingService');
const { inferTopicsFromQuestion } = require('../utils/topicClassifier');
const Groq = require('groq-sdk');
const { rewriteQuery } = require("../utils/queryRewrite");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MAX_CONTEXT_CHARS = 14000;
const MAX_HISTORY_TURNS = 6;

// ─────────────────────────────────────────────
// BUILD SYSTEM PROMPT
// ─────────────────────────────────────────────
const buildSystemPrompt = (ragContext, lessonContent) => {
    const lessonBlock = lessonContent
        ? `\n\n=== NỘI DUNG BÀI HỌC HIỆN TẠI (ƯU TIÊN CAO NHẤT — đây là bài học người dùng đang xem) ===\n${lessonContent}\n=== KẾT THÚC NỘI DUNG BÀI HỌC ===`
        : "";

    return `Bạn là trợ lý học tập AI thông minh, chuyên trả lời câu hỏi dựa trên tài liệu học.

QUY TẮC:
- Khi câu hỏi liên quan đến "bài học hôm nay", "nội dung hôm nay", "bài này" → ĐỌC từ "NỘI DUNG BÀI HỌC HIỆN TẠI"
- Ưu tiên dùng "NỘI DUNG BÀI HỌC HIỆN TẠI" nếu câu hỏi liên quan đến nội dung đang học
- Sau đó mới dùng "NGỮ CẢNH TÀI LIỆU" từ cơ sở dữ liệu RAG
- Nếu không có thông tin → trả lời "Tài liệu không đề cập đến vấn đề này."
- KHÔNG suy đoán hoặc thêm kiến thức ngoài tài liệu
- Trả lời bằng tiếng Việt, rõ ràng, có cấu trúc (bullet point nếu cần)
- Duy trì ngữ cảnh hội thoại — nhớ câu hỏi/trả lời trước đó
${lessonBlock}

NGỮ CẢNH TÀI LIỆU (từ cơ sở dữ liệu RAG):
${ragContext || "(Không tìm thấy đoạn liên quan)"}`;
};

// ─────────────────────────────────────────────
// TRIM HISTORY
// ─────────────────────────────────────────────
const trimHistory = (history = []) => {
    if (!Array.isArray(history)) return [];
    return history.slice(-(MAX_HISTORY_TURNS * 2));
};

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
const answerQuestionWithRAG = async (
    question,
    planId,
    coveredSections = [],
    conversationHistory = [],
    lessonContent = null
) => {
    try {
        if (!question || !planId) {
            return { answer: "Thiếu dữ liệu đầu vào.", sources: [] };
        }

        console.log("🧠 RAG Question:", question, "| Has lesson content:", !!lessonContent);

        // 1. Embed + rewrite query
        const rewritten = await rewriteQuery(question);
        const queryVector = await generateEmbedding(rewritten, "query");

        // 2. Infer allowed topics from question
        const allowedTopics = inferTopicsFromQuestion(question);
        if (allowedTopics.length) {
            console.log("🏷️ RAG topic filter:", allowedTopics);
        } else {
            console.log("🏷️ RAG topic filter: none (broad question)");
        }

        // 3. Retrieve chunks (section → topic-filtered → plain)
        let relevantChunks = [];
        if (coveredSections?.length > 0) {
            relevantChunks = await searchChunksBySection(planId, coveredSections, queryVector, 6);
        } else {
            // ⭐ Use topic-filtered search
            relevantChunks = await searchRelevantChunksByTopic(planId, queryVector, allowedTopics, 6);
        }

        // 4. Build RAG context string
        let ragContext = "";
        for (const c of relevantChunks) {
            const line = `[${c.section || "Tài liệu"}]\n${c.content}\n\n`;
            if ((ragContext + line).length > MAX_CONTEXT_CHARS) break;
            ragContext += line;
        }

        // Nếu không có chunks VÀ không có lessonContent → báo lỗi
        if (!relevantChunks.length && !lessonContent) {
            return {
                answer: "Tài liệu không có thông tin liên quan đến câu hỏi này. Hãy thử hỏi về nội dung cụ thể trong bài học.",
                sources: []
            };
        }

        console.log("📚 RAG:", ragContext.length, "chars | Lesson:", lessonContent?.length || 0, "chars | History:", conversationHistory.length, "msgs");

        // 4. Build messages
        const systemPrompt = buildSystemPrompt(ragContext, lessonContent);
        const history = trimHistory(conversationHistory);

        const messages = [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: question }
        ];

        // 5. LLM
        const res = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            temperature: 0.1,
            max_tokens: 1200,
            messages,
        });

        const answer = res.choices?.[0]?.message?.content || "Không có câu trả lời.";

        return {
            answer,
            sources: relevantChunks.map(c => ({
                section: c.section,
                preview: c.content.substring(0, 120)
            }))
        };

    } catch (error) {
        console.error("❌ RAG Error:", error.message);
        return {
            answer: "Lỗi xử lý câu hỏi. Vui lòng thử lại.",
            sources: []
        };
    }
};

module.exports = { answerQuestionWithRAG };