// services/lessonQuizService.js
// ─────────────────────────────────────────────────────────────────────────────
// Dịch vụ Quiz thích nghi — luồng đã được đơn giản hóa:
//   1. generateQuizPool(lessonId)               → Sinh pool câu hỏi từ nội dung bài
//   2. selectQuestionsAdaptive(lessonId, level) → Chọn câu theo trình độ
//   3. processAdaptiveResult(...)               → Ghi điểm → mở bài tiếp → trả kết quả
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Groq = require("groq-sdk");

const Lesson   = require("../models/Lesson");
const Chunk    = require("../models/Chunk");
const Progress = require("../models/Progress");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Hằng số ──────────────────────────────────────────────────────────────────
const POOL_SIZE = 30; // Số câu trong quizPool

// Phân bổ độ khó theo trình độ người dùng
const DIFFICULTY_DIST = {
  BEGINNER:     { easy: 0.6, medium: 0.3, hard: 0.1 },
  INTERMEDIATE: { easy: 0.2, medium: 0.5, hard: 0.3 },
  EXPERT:       { easy: 0.1, medium: 0.3, hard: 0.6 },
};

// ── Hàm phụ trợ (Retry Logic) ────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryWithBackoff = async (fn, maxRetries = 4) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const msg = String(err?.error?.message || err?.message || "");
      const isRateLimit = /rate_limit_exceeded|429/i.test(msg) || err?.status === 429;
      
      if (!isRateLimit) throw err;
      if (attempt === maxRetries - 1) {
        console.error("[lessonQuizService] Max retries reached for Rate Limit.");
        throw err;
      }

      // Cố gắng đọc thời gian chờ từ thông báo lỗi của Groq (ví dụ: "try again in 16.21s")
      let waitTime = 2500 * Math.pow(2, attempt); // Fallback: 2.5s, 5s, 10s
      const match = msg.match(/try again in ([\d.]+)s/i);
      if (match && match[1]) {
        waitTime = parseFloat(match[1]) * 1000 + 1000; // Đổi sang ms và cộng thêm 1s bù trừ
      }

      console.warn(`[lessonQuizService] Rate limit hit. Waiting ${Math.round(waitTime)}ms before retry ${attempt + 1}/${maxRetries}...`);
      await sleep(waitTime);
    }
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// 1. SINH QUIZ POOL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sinh pool câu hỏi trắc nghiệm từ nội dung bài học.
 * Phân bổ số lượng và độ khó dựa theo learningFocus và learningDepth của Plan.
 */
const generateQuizPool = async (lessonId) => {
  const lesson = await Lesson.findById(lessonId).populate("planId");
  if (!lesson) throw new Error("Không tìm thấy bài học");

  const plan  = lesson.planId;
  const focus = plan?.learningFocus || plan?.learningGoals?.focus || "theory";
  const depth = plan?.learningDepth || plan?.learningGoals?.depth || "basic";

  // ────────────────────────────────────────────────
  // 4 CHẾ ĐỘ QUIZ DỰA THEO TRỌNG TÂM + MỨC ĐỘ
  // ────────────────────────────────────────────────
  let numQuestions, easyRatio, mediumRatio, hardRatio;

  if (focus === "practice" && depth === "deep") {
    // Chế độ 4: Thực hành + Chuyên sâu: 20 câu khó, vận dụng bài toán cụ thể
    numQuestions = 20; easyRatio = 0.05; mediumRatio = 0.25; hardRatio = 0.70;
  } else if (focus === "practice" && depth === "basic") {
    // Chế độ 2: Thực hành + Cơ bản: 15 câu, độ khó vừa phải
    numQuestions = 15; easyRatio = 0.20; mediumRatio = 0.55; hardRatio = 0.25;
  } else if (focus === "theory" && depth === "deep") {
    // Chế độ 3: Lý thuyết + Chuyên sâu: 10 câu khó
    numQuestions = 10; easyRatio = 0.10; mediumRatio = 0.20; hardRatio = 0.70;
  } else {
    // Chế độ 1 (mặc định): Lý thuyết + Cơ bản: 10 câu, nhiều câu dễ
    numQuestions = 10; easyRatio = 0.50; mediumRatio = 0.35; hardRatio = 0.15;
  }

  console.log(`[QuizPool] Mode: Focus=${focus}, Depth=${depth} → ${numQuestions} câu | Easy=${easyRatio*100}% Med=${mediumRatio*100}% Hard=${hardRatio*100}%`);

  let context = lesson.content || "";
  context = context.substring(0, 2500);

  const prompt = _buildQuizPoolPrompt(
    lesson.title,
    lesson.summary || "",
    context,
    numQuestions,
    easyRatio,
    mediumRatio,
    hardRatio,
    focus,
    depth
  );

  const completion = await retryWithBackoff(() =>
    groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.5,
      max_tokens: 4000,
    })
  );

  const parsed    = JSON.parse(completion.choices[0].message.content);
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];

  await Lesson.findByIdAndUpdate(lessonId, { quizPool: questions });
  console.log(`✅ Quiz pool: ${questions.length} câu cho "${lesson.title}" (Focus: ${focus}, Depth: ${depth})`);

  return questions;
};


// ─────────────────────────────────────────────────────────────────────────────
// 2. CHỌN CÂU HỎI THEO TRÌNH ĐỘ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chọn n câu từ pool theo trình độ người dùng (BEGINNER / INTERMEDIATE / EXPERT).
 * Tự động sinh pool nếu chưa đủ câu.
 */
const selectQuestionsAdaptive = async (lessonId, userLevel = "INTERMEDIATE", numQuestions = 10) => {
  const lesson = await Lesson.findById(lessonId).lean();
  if (!lesson) throw new Error("Không tìm thấy bài học");

  const pool = lesson.quizPool || [];
  // KHÔNG tự generate ở đây để tránh double-call.
  // Frontend đã gọi generatePool riêng và đợi polling.
  if (pool.length === 0) {
    return []; // trả về rỗng, frontend sẽ poll tiếp
  }

  const dist   = DIFFICULTY_DIST[userLevel] || DIFFICULTY_DIST.INTERMEDIATE;
  const easy   = pool.filter((q) => q.difficulty === "easy");
  const medium = pool.filter((q) => q.difficulty === "medium");
  const hard   = pool.filter((q) => q.difficulty === "hard");

  const picked = [
    ..._pickRandom(easy,   Math.round(numQuestions * dist.easy)),
    ..._pickRandom(medium, Math.round(numQuestions * dist.medium)),
    ..._pickRandom(hard,   Math.round(numQuestions * dist.hard)),
  ];

  // Bù nếu một nhóm độ khó không đủ số lượng
  if (picked.length < numQuestions) {
    const usedSet   = new Set(picked.map((q) => q.question));
    const remaining = pool.filter((q) => !usedSet.has(q.question));
    picked.push(..._shuffle(remaining).slice(0, numQuestions - picked.length));
  }

  return _shuffle(picked).slice(0, numQuestions);
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. XỬ LÝ KẾT QUẢ — GHI ĐIỂM + MỞ BÀI TIẾP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nhận điểm quiz → ghi vào Progress → mở bài tiếp → trả kết quả.
 * Không còn tạo bài ôn tập hay nâng cao dựa vào điểm số.
 */
const processAdaptiveResult = async (userId, planId, dayNumber, score, lessonId) => {
  // Ghi lịch sử điểm của bài học
  await Progress.findOneAndUpdate(
    { userId, planId },
    { $pull: { lessonScores: { dayNumber: Number(dayNumber) } } },
    { upsert: true }
  );
  await Progress.findOneAndUpdate(
    { userId, planId },
    {
      $push: {
        lessonScores: {
          dayNumber: Number(dayNumber),
          score,
          passedAt: new Date(),
        },
      },
    }
  );

  // Mở bài học tiếp theo
  const nextDay = Number(dayNumber) + 1;
  const unlocked = await Lesson.findOneAndUpdate(
    { planId, dayNumber: nextDay, status: "locked" },
    { status: "in-progress" },
    { new: true }
  );

  console.log(
    `✅ Quiz completed: day=${dayNumber} score=${score}% → ${unlocked ? `mở bài ${nextDay}` : "không còn bài locked"}`
  );

  return {
    action:        "completed",
    score,
    message:       score >= 60
      ? `Hoàn thành! Bạn đạt ${score}%. Bài học tiếp theo đã được mở.`
      : `Bạn đạt ${score}%. Cố gắng hơn ở bài sau nhé!`,
    nextUnlocked:  !!unlocked,
    nextDayNumber: unlocked ? nextDay : null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const _pickRandom = (arr, n) =>
  [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length));

const _shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

const _buildQuizPoolPrompt = (lessonTitle, lessonSummary, context, numQuestions, easyRatio, mediumRatio, hardRatio, focus, depth) => {
  let focusInstruction;
  if (focus === "practice" && depth === "deep") {
    focusInstruction = "TẬP TRUNG THỰC HÀNH CHUYÊN SÂU: Tạo câu hỏi dựa vào tình huống thực tế cụ thể (bài toán, đoạn code, debug), đòi hỏi phân tích nguyên nhân, so sánh giải pháp và vận dụng thành thạo.";
  } else if (focus === "practice") {
    focusInstruction = "TẬP TRUNG THỰC HÀNH: Tạo câu hỏi kiểm tra khả năng sử dụng, vận dụng kiến thức vào bài toán đơn giản, nhận diện ứng dụng phù hợp.";
  } else if (depth === "deep") {
    focusInstruction = "TẬP TRUNG LÝ THUYẾT CHUYÊN SÂU: Tạo câu hỏi phân tích sâu về nguyên lý, so sánh khái niệm tương đồng, đánh giá tính đúng/sai trong điều kiện cụ thể.";
  } else {
    focusInstruction = "TẬP TRUNG LÝ THUYẾT CƠ BẢN: Kiểm tra hiểu biết về định nghĩa, thuật ngữ, các đặc điểm và nguyên lý cần ghi nhớ.";
  }

  return `
Bạn là chuyên gia khảo thí. Nhiệm vụ: Tạo ĐÚNG ${numQuestions} câu hỏi trắc nghiệm cho bài học sau.

=== BÀI HỌC: "${lessonTitle}" ===
Tóm tắt: ${lessonSummary}
---
${context}
=== KẾT THÚC NỘI DUNG ===

YÊU CẦU BẮT BUỘC:
1. Tạo CHÍNH XÁC ${numQuestions} câu - không ít hơn, không nhiều hơn
2. Mỗi câu kiểm tra một khía cạnh KHÁC NHAU, không lặp lại concept
3. Câu hỏi CHỈ dựa vào nội dung bài học, lọc ra các tiêu đề hoặc nội dung quan trọng nhất
4. Mỗi câu có 4 đáp án: 1 đúng, 3 sai nhưng hợp lý
5. ${focusInstruction}

PHÂN BỔ ĐỘ KHÓ (bắt buộc, tổng phải bằng ${numQuestions}):
- ${Math.round(numQuestions * easyRatio)} câu DỄ (easy): Nhận biết / Ghi nhớ — định nghĩa, thuật ngữ
- ${Math.round(numQuestions * mediumRatio)} câu TRUNG BÌNH (medium): Thông hiểu / Vận dụng
- ${Math.round(numQuestions * hardRatio)} câu KHÓ (hard): Phân tích / Đánh giá tình huống

Trả về JSON thuần túy:
{
  "questions": [
    {
      "question": "Câu hỏi cụ thể?",
      "options": ["Đáp án A", "Đáp án B", "Đáp án C", "Đáp án D"],
      "correctAnswer": 0,
      "explanation": "Giải thích ngắn gọn",
      "difficulty": "easy|medium|hard",
      "bloomLevel": "Nhận biết|Thông hiểu|Vận dụng|Phân tích|Đánh giá"
    }
  ]
}`;
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  generateQuizPool,
  selectQuestionsAdaptive,
  processAdaptiveResult,
};