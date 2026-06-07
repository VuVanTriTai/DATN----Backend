// services/lessonQuizService.js
// ─────────────────────────────────────────────────────────────────────────────
// Dịch vụ Quiz thích nghi — luồng đã được đơn giản hóa:
//   1. generateQuizPool(lessonId)               → Sinh pool câu hỏi từ nội dung bài
//   2. selectQuestionsAdaptive(lessonId, level) → Chọn câu theo trình độ
//   3. processAdaptiveResult(...)               → Ghi điểm → mở bài tiếp → trả kết quả
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Lesson   = require("../models/Lesson");
const Chunk    = require("../models/Chunk");
const Progress = require("../models/Progress");
const { makeGroqRequest } = require("./planService");

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
    // 4. Thực hành - Nâng cao: 20 câu, độ khó cao, liên quan nhiều đến thực hành, áp dụng lý thuyết
    numQuestions = 20; easyRatio = 0.05; mediumRatio = 0.25; hardRatio = 0.70;
  } else if (focus === "practice" && depth === "basic") {
    // 3. Thực hành - Cơ bản: 20 câu, độ khó cơ bản, liên quan nhiều đến thực hành, áp dụng lý thuyết
    numQuestions = 20; easyRatio = 0.30; mediumRatio = 0.50; hardRatio = 0.20;
  } else if (focus === "theory" && depth === "deep") {
    // 2. Lý thuyết - Nâng cao: 10 câu, độ khó cao, liên quan nhiều đến lý thuyết
    numQuestions = 10; easyRatio = 0.10; mediumRatio = 0.30; hardRatio = 0.60;
  } else {
    // 1. Lý thuyết - Cơ bản: 10 câu, độ khó cơ bản, liên quan nhiều đến lý thuyết
    numQuestions = 10; easyRatio = 0.60; mediumRatio = 0.30; hardRatio = 0.10;
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

  // Thiết lập temperature động dựa theo Focus & Depth để AI sáng tạo câu hỏi vận dụng khi cần
  let temperature = 0.0;
  if (focus === "practice" && depth === "deep") {
    temperature = 0.5; // Chế độ thực hành chuyên sâu: cần tạo tình huống thực tế, code debug phức tạp
  } else if (focus === "practice") {
    temperature = 0.3; // Thực hành cơ bản: câu hỏi vận dụng đơn giản
  } else if (depth === "deep") {
    temperature = 0.3; // Lý thuyết chuyên sâu: so sánh nguyên lý, phân tích tình huống
  }

  console.log(`[QuizPool] Selected temperature: ${temperature}`);

  // Sử dụng makeGroqRequest hỗ trợ xoay vòng API keys + fallback Gemini.
  const resText = await makeGroqRequest({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.1-8b-instant",
    temperature,
    enforceJSON: true
  });

  const parsed    = JSON.parse(resText);
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
  const lesson = await Lesson.findById(lessonId);
  if (!lesson) throw new Error("Không tìm thấy bài học");

  // Nếu bài học đã được chọn sẵn quiz (lesson.quiz có dữ liệu), trả về luôn câu hỏi đã lưu
  if (Array.isArray(lesson.quiz) && lesson.quiz.length >= Math.min(numQuestions, 3)) {
    return lesson.quiz;
  }

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

  const finalQuestions = _shuffle(picked).slice(0, numQuestions);

  // Lưu lại bộ quiz được chọn để cố định câu hỏi cho học viên
  lesson.quiz = finalQuestions;
  await lesson.save();

  return finalQuestions;
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
    focusInstruction = "TẬP TRUNG THỰC HÀNH CHUYÊN SÂU: Tạo câu hỏi dựa vào tình huống thực tế cụ thể (case study thực tế, bài toán phân tích, đoạn code, chẩn đoán lỗi/vấn đề), đòi hỏi phân tích nguyên nhân cốt lõi, so sánh ưu/nhược điểm của các giải pháp và vận dụng kiến thức chuyên sâu.";
  } else if (focus === "practice") {
    focusInstruction = "TẬP TRUNG THỰC HÀNH CƠ BẢN: Tạo câu hỏi kiểm tra khả năng áp dụng kiến thức vào bài toán/tình huống thực tiễn đơn giản, nhận diện ứng dụng phù hợp trong ngữ cảnh.";
  } else if (depth === "deep") {
    focusInstruction = "TẬP TRUNG LÝ THUYẾT CHUYÊN SÂU: Tạo câu hỏi so sánh đối chiếu khái niệm tương đồng, giải thích nguyên lý vận hành sâu xa, đánh giá tính đúng/sai dưới các ràng buộc hoặc điều kiện cụ thể.";
  } else {
    focusInstruction = "TẬP TRUNG LÝ THUYẾT CƠ BẢN: Kiểm tra sự hiểu biết về định nghĩa, thuật ngữ chuyên môn, các đặc điểm nhận biết cốt lõi và nguyên lý cơ bản cần ghi nhớ.";
  }

  return `Bạn là chuyên gia khảo thí và biên soạn câu hỏi trắc nghiệm khách quan. Nhiệm vụ của bạn là tạo đúng ${numQuestions} câu hỏi trắc nghiệm dựa TRÊN DUY NHẤT nội dung bài học được cung cấp dưới đây.

=== BÀI HỌC: "${lessonTitle}" ===
Tóm tắt: ${lessonSummary}
---
${context}
=== KẾT THÚC NỘI DUNG ===

YÊU CẦU NGHIÊM NGẶT VỀ NỘI DUNG & CHẤT LƯỢNG (HẠN CHẾ HALLUCINATION & BẢO ĐẢM TÍNH ĐÚNG ĐẮN):
1. CHỈ SỬ DỤNG thông tin được đề cập trực tiếp trong nội dung bài học ở trên. Không sử dụng kiến thức hoặc suy diễn bên ngoài.
2. MỖI CÂU HỎI CHỈ ĐƯỢC PHÉP CÓ DUY NHẤT 1 ĐÁP ÁN ĐÚNG. 3 phương án còn lại bắt buộc phải là đáp án SAI hoàn toàn và không thể tranh cãi.
3. TUYỆT ĐỐI KHÔNG sinh câu hỏi có nhiều hơn một đáp án đúng hoặc mập mờ về mặt ngữ nghĩa/kỹ thuật.
4. Giá trị "correctAnswer" phải là số nguyên (0, 1, 2, hoặc 3) trỏ CHÍNH XÁC đến vị trí của đáp án đúng duy nhất trong mảng "options". Nghiêm cấm đặt sai lệch index của đáp án đúng.
5. Giải thích ("explanation") phải ghi rõ lý do đáp án đó đúng và giải thích ngắn gọn vì sao 3 phương án còn lại sai dựa vào bài học.
6. ${focusInstruction}

QUY TRÌNH TỰ KIỂM TRA CHÉO (SELF-VERIFY):
Trước khi trả về JSON, bạn phải duyệt qua từng câu hỏi trong danh sách:
- Đọc lại nội dung câu hỏi.
- Lấy đáp án tại vị trí options[correctAnswer] kiểm tra xem nó có đúng 100% không.
- Kiểm tra xem 3 options còn lại có thực sự sai lệch 100% không.
Nếu phát hiện lỗi logic hoặc lệch index, hãy sửa lại ngay lập tức trước khi xuất kết quả.

PHÂN BỔ SỐ LƯỢNG VÀ ĐỘ KHÓ (Tổng số câu hỏi phải bằng chính xác ${numQuestions}):
- ${Math.round(numQuestions * easyRatio)} câu DỄ (easy): Nhận biết / Ghi nhớ định nghĩa, cú pháp hoặc thuật ngữ cụ thể.
- ${Math.round(numQuestions * mediumRatio)} câu TRUNG BÌNH (medium): Thông hiểu / Vận dụng trực tiếp trong ngữ cảnh.
- ${Math.round(numQuestions * hardRatio)} câu KHÓ (hard): Phân tích / Đánh giá tình huống hoặc giải quyết vấn đề.

Trả về kết quả dưới dạng JSON thuần túy (không kèm markdown block ngoài JSON):
{
  "questions": [
    {
      "question": "Nội dung câu hỏi trắc nghiệm?",
      "options": ["Lựa chọn 1", "Lựa chọn 2", "Lựa chọn 3", "Lựa chọn 4"],
      "correctAnswer": 0,
      "explanation": "Giải thích câu đúng dựa hoàn toàn trên bài học ở trên.",
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