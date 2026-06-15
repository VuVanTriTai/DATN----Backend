// services/ragService.js
"use strict";

const { searchRelevantChunks, searchChunksBySection, searchRelevantChunksByTopic } = require('./vectorSearchService');
const { generateEmbedding } = require('./embeddingService');
const { inferTopicsFromQuestion } = require('../utils/topicClassifier');
const Groq = require('groq-sdk');
const { rewriteQuery } = require("../utils/queryRewrite");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MAX_CONTEXT_CHARS = 12000;  // tăng từ 10000 → 12000 để có nhiều context hơn cho RAG
const MAX_HISTORY_TURNS = 6;
const RAG_RETRIEVE_K    = 12;     // Tăng từ 6 → 12: lấy nhiều chunk hơn rồi re-rank lại
const RAG_USE_K         = 6;      // Sau re-rank chỉ dùng top-6 cho context

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
// RE-RANKING: Chọn top chunk phù hợp nhất với câu hỏi
// Sử dụng keyword overlap (tốc độ nhanh, không cần LLM)
// ─────────────────────────────────────────────
const RERANK_STOP_WORDS = new Set([
    'là', 'của', 'và', 'các', 'cho', 'với', 'những', 'một', 'được',
    'này', 'khi', 'thì', 'không', 'phải', 'như', 'theo',
    'the', 'a', 'an', 'is', 'in', 'of', 'to', 'and', 'or', 'for', 'with'
]);

const _extractKeywords = (text) => {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\w\s\u00C0-\u024F]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !RERANK_STOP_WORDS.has(w));
};

const _keywordOverlap = (queryKeywords, chunkContent) => {
    if (!queryKeywords.length) return 0;
    const lower = chunkContent.toLowerCase();
    let hits = 0;
    for (const kw of queryKeywords) {
        if (lower.includes(kw)) hits++;
    }
    return hits / queryKeywords.length;
};

/**
 * Re-rank chunks: kết hợp vector score (từ DB) + keyword overlap.
 * finalScore = 0.7 * vectorScore + 0.3 * keywordScore
 */
const rerankChunks = (question, chunks, topK = RAG_USE_K) => {
    if (!chunks || chunks.length === 0) return [];
    const queryKeywords = _extractKeywords(question);

    const scored = chunks.map(c => {
        const vectorScore = typeof c.score === 'number' ? c.score : 0;
        const kwScore     = _keywordOverlap(queryKeywords, c.content);
        const finalScore  = 0.7 * vectorScore + 0.3 * kwScore;
        return { ...c, _rerankScore: finalScore };
    });

    scored.sort((a, b) => b._rerankScore - a._rerankScore);
    const selected = scored.slice(0, topK);

    console.log(
        `[✏️ Re-rank] ${chunks.length} → ${selected.length} chunks | ` +
        `scores: ${selected.map(c => c._rerankScore.toFixed(2)).join(', ')}`
    );
    return selected;
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
            relevantChunks = await searchChunksBySection(planId, coveredSections, queryVector, RAG_RETRIEVE_K);
        } else {
            // ⭐ Use topic-filtered search, lấy nhiều hơn (RAG_RETRIEVE_K) để re-rank
            relevantChunks = await searchRelevantChunksByTopic(planId, queryVector, allowedTopics, RAG_RETRIEVE_K);
        }

        // 3b. Re-rank chunks — chọn top-RAG_USE_K phù hợp nhất
        relevantChunks = rerankChunks(question, relevantChunks, RAG_USE_K);

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
        // dùng 70b model để hiểu tài liệu học thuật/khoa học chính xác hơn
        model: "llama-3.3-70b-versatile",
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