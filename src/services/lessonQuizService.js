// services/lessonQuizService.js
// ─────────────────────────────────────────────────────────────────────────────
// Dịch vụ Quiz thích nghi — luồng đã được đơn giản hóa:
//   1. generateQuizPool(lessonId)               → Sinh pool câu hỏi từ nội dung bài
//   2. selectQuestionsAdaptive(lessonId, level) → Chọn câu theo trình độ
//   3. processAdaptiveResult(...)               → Ghi điểm → mở bài tiếp → trả kết quả
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Lesson = require("../models/Lesson");
const Chunk = require("../models/Chunk");
const Progress = require("../models/Progress");
const { makeGroqRequest } = require("./planService");

// ── Hằng số ──────────────────────────────────────────────────────────────────
const POOL_SIZE = 30; // Số câu trong quizPool

// Phân bổ độ khó theo trình độ người dùng
const DIFFICULTY_DIST = {
  BEGINNER: { easy: 0.6, medium: 0.3, hard: 0.1 },
  INTERMEDIATE: { easy: 0.2, medium: 0.5, hard: 0.3 },
  EXPERT: { easy: 0.1, medium: 0.3, hard: 0.6 },
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
// Lock tránh 2 request sinh quiz cho cùng 1 lesson cùng lúc
const _generatingPools = new Set();

const generateQuizPool = async (lessonId) => {
  const lessonIdStr = String(lessonId);

  if (_generatingPools.has(lessonIdStr)) {
    console.warn(`[QuizPool] Đang sinh pool cho ${lessonIdStr}, bỏ qua request trùng`);
    await sleep(15000);
    const lessonCached = await Lesson.findById(lessonId).lean();
    return lessonCached?.quizPool || [];
  }

  _generatingPools.add(lessonIdStr);

  try {
    const lesson = await Lesson.findById(lessonId).populate("planId");
    if (!lesson) throw new Error("Không tìm thấy bài học");

    const plan = lesson.planId;
    const focus = plan?.learningFocus || plan?.learningGoals?.focus || "theory";
    const depth = plan?.learningDepth || plan?.learningGoals?.depth || "basic";

    let numQuestions, easyRatio, mediumRatio, hardRatio;

    if (focus === "practice" && depth === "deep") {
      numQuestions = 20; easyRatio = 0.05; mediumRatio = 0.25; hardRatio = 0.70;
    } else if (focus === "practice" && depth === "basic") {
      numQuestions = 20; easyRatio = 0.30; mediumRatio = 0.50; hardRatio = 0.20;
    } else if (focus === "theory" && depth === "deep") {
      numQuestions = 10; easyRatio = 0.10; mediumRatio = 0.30; hardRatio = 0.60;
    } else {
      numQuestions = 10; easyRatio = 0.60; mediumRatio = 0.30; hardRatio = 0.10;
    }

    console.log(`[QuizPool] Mode: Focus=${focus}, Depth=${depth} → ${numQuestions} câu | Easy=${easyRatio * 100}% Med=${mediumRatio * 100}% Hard=${hardRatio * 100}%`);

    let context = lesson.content || "";
    context = context.substring(0, 2500);

    let temperature = 0.0;
    if (focus === "practice" && depth === "deep") {
      temperature = 0.5;
    } else if (focus === "practice") {
      temperature = 0.3;
    } else if (depth === "deep") {
      temperature = 0.3;
    }

    console.log(`[QuizPool] Selected temperature: ${temperature}`);

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

    // ── Lần 1: gọi với prompt đầy đủ ────────────────────────────────────────
    let parsed;
    try {
      const resText = await makeGroqRequest({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.1-8b-instant",
        temperature,
        maxTokens: 4000,
        enforceJSON: true,
      });
      parsed = extractJSON(resText);
    } catch (err) {
      console.warn("[QuizPool] Lần 1 thất bại:", err.message, "→ thử lại với prompt đơn giản hơn...");

      // ── Lần 2: prompt tối giản, temperature=0, context ngắn hơn ────────────
      try {
        const retryResText = await makeGroqRequest({
          messages: [
            {
              role: "system",
              content: "Output ONLY valid JSON. Start with '{'. No explanation, no markdown.",
            },
            {
              role: "user",
              content:
                `Tạo ${numQuestions} câu trắc nghiệm về "${lesson.title}" dựa trên:\n${context.slice(0, 1500)}\n\n` +
                `JSON: {"questions":[{"question":"...","options":["A","B","C","D"],"correctAnswer":0,"explanation":"...","difficulty":"easy|medium|hard","bloomLevel":"..."}]}`,
            },
          ],
          model: "llama-3.1-8b-instant",
          temperature: 0,
          maxTokens: 3000,
          enforceJSON: true,
        });
        parsed = extractJSON(retryResText);
      } catch (retryErr) {
        throw new Error(`generateQuizPool thất bại sau 2 lần: ${retryErr.message}`);
      }
    }

    const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];

    if (questions.length === 0) {
      throw new Error("Model trả về 0 câu hỏi hợp lệ");
    }

    const validQuestions = questions.filter(
      (q) => q?.question && Array.isArray(q?.options) && q.options.length >= 2
    );

    if (validQuestions.length === 0) {
      throw new Error("Tất cả câu hỏi đều bị lỗi cấu trúc");
    }

    await Lesson.findByIdAndUpdate(lessonId, { quizPool: validQuestions });
    console.log(`✅ Quiz pool: ${validQuestions.length} câu cho "${lesson.title}" (Focus: ${focus}, Depth: ${depth})`);

    return validQuestions;

  } finally {
    _generatingPools.delete(lessonIdStr);
  }
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

  const dist = DIFFICULTY_DIST[userLevel] || DIFFICULTY_DIST.INTERMEDIATE;
  const easy = pool.filter((q) => q.difficulty === "easy");
  const medium = pool.filter((q) => q.difficulty === "medium");
  const hard = pool.filter((q) => q.difficulty === "hard");

  const picked = [
    ..._pickRandom(easy, Math.round(numQuestions * dist.easy)),
    ..._pickRandom(medium, Math.round(numQuestions * dist.medium)),
    ..._pickRandom(hard, Math.round(numQuestions * dist.hard)),
  ];

  // Bù nếu một nhóm độ khó không đủ số lượng
  if (picked.length < numQuestions) {
    const usedSet = new Set(picked.map((q) => q.question));
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
    action: "completed",
    score,
    message: score >= 60
      ? `Hoàn thành! Bạn đạt ${score}%. Bài học tiếp theo đã được mở.`
      : `Bạn đạt ${score}%. Cố gắng hơn ở bài sau nhé!`,
    nextUnlocked: !!unlocked,
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
    focusInstruction = "Tạo câu hỏi dựa vào tình huống thực tế, đòi hỏi phân tích nguyên nhân và so sánh giải pháp.";
  } else if (focus === "practice") {
    focusInstruction = "Tạo câu hỏi kiểm tra khả năng vận dụng kiến thức vào bài toán cụ thể.";
  } else if (depth === "deep") {
    focusInstruction = "Tạo câu hỏi phân tích sâu về nguyên lý, so sánh khái niệm tương đồng.";
  } else {
    focusInstruction = "Tạo câu hỏi kiểm tra hiểu biết về định nghĩa, thuật ngữ, các đặc điểm cần ghi nhớ.";
  }

  const easyCount = Math.round(numQuestions * easyRatio);
  const mediumCount = Math.round(numQuestions * mediumRatio);
  const hardCount = numQuestions - easyCount - mediumCount; // dùng trừ để đảm bảo tổng đúng

  return `Bạn là chuyên gia khảo thí. Tạo ĐÚNG ${numQuestions} câu hỏi trắc nghiệm cho bài học sau.

=== NỘI DUNG BÀI HỌC: "${lessonTitle}" ===
${lessonSummary ? `Tóm tắt: ${lessonSummary}\n` : ""}${context}
=== KẾT THÚC ===

YÊU CẦU BẮT BUỘC:
1. Tạo CHÍNH XÁC ${numQuestions} câu — array "questions" phải có đúng ${numQuestions} phần tử.
2. ${focusInstruction}
3. Câu hỏi CHỈ dựa vào nội dung bài học, không bịa thêm thông tin ngoài.
4. Mỗi câu kiểm tra một khía cạnh KHÁC NHAU, không lặp lại concept.

QUY TẮC BẮT BUỘC VỀ ĐỊNH DẠNG CÂU HỎI:
- Mỗi câu phải là câu hỏi có nội dung rõ ràng, kết thúc bằng dấu "?"
- 4 đáp án phải là các phương án CỤ THỂ, KHÁC NHAU về nội dung
- NGHIÊM CẤM dùng đáp án chung chung như "Đúng", "Sai", "Không rõ", "Không liên quan", "Tất cả đều đúng", "Tất cả đều sai"
- Đáp án sai phải hợp lý, dễ nhầm lẫn — không phải vô nghĩa
- Ví dụ câu hỏi TỐT: "Khoảng cách từ nhà máy VinFast đến Cảng Tân Vũ là bao nhiêu?" với đáp án "18 km", "25 km", "12 km", "30 km"
- Ví dụ câu hỏi XẤU (NGHIÊM CẤM): "Phát biểu X có đúng không?" với đáp án "Đúng / Sai / Không rõ / Không liên quan"

PHÂN BỔ ĐỘ KHÓ (bắt buộc, tổng = ${numQuestions}):
- ${easyCount} câu "easy": câu hỏi nhận biết, ghi nhớ sự kiện, con số, định nghĩa
- ${mediumCount} câu "medium": câu hỏi thông hiểu, so sánh, vận dụng đơn giản  
- ${hardCount} câu "hard": câu hỏi phân tích, đánh giá tình huống phức tạp

Trả về JSON hợp lệ, bắt đầu bằng '{', không có text trước hoặc sau:
{
  "questions": [
    {
      "question": "Câu hỏi cụ thể có nội dung rõ ràng?",
      "options": ["Đáp án A cụ thể", "Đáp án B cụ thể", "Đáp án C cụ thể", "Đáp án D cụ thể"],
      "correctAnswer": 0,
      "explanation": "Giải thích ngắn gọn tại sao đáp án đúng",
      "difficulty": "easy",
      "bloomLevel": "Nhận biết"
    }
  ]
}`;
};
// ── JSON Extractor (rescue khi model trả text trước JSON) ────────────────────
const extractJSON = (raw) => {
  if (!raw || typeof raw !== "string") throw new Error("Empty response");

  // Thử parse thẳng trước
  try { return JSON.parse(raw); } catch (_) { }

  // Tìm markdown code block ```json ... ``` trước (ưu tiên hơn vì rõ ràng hơn)
  const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (mdMatch?.[1]) {
    try { return JSON.parse(mdMatch[1].trim()); } catch (_) { }
  }

  // Tìm vị trí { hoặc [ đầu tiên
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const start = [firstBrace, firstBracket]
    .filter((i) => i >= 0)
    .reduce((min, i) => Math.min(min, i), Infinity);

  if (start === Infinity) {
    throw new Error(`Cannot extract JSON from response: ${raw.slice(0, 120)}`);
  }

  // Tìm vị trí } hoặc ] cuối cùng
  const lastBrace = raw.lastIndexOf("}");
  const lastBracket = raw.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);

  if (end < start) {
    throw new Error(`Cannot extract JSON from response: ${raw.slice(0, 120)}`);
  }

  const candidate = raw.slice(start, end + 1);

  // Thử parse thẳng
  try { return JSON.parse(candidate); } catch (_) { }

  // Thử escape newline bên trong string rồi parse lại
  try {
    const escaped = candidate.replace(/("(?:[^"\\]|\\.)*")/g, (m) =>
      m.replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    );
    return JSON.parse(escaped);
  } catch (_) { }

  throw new Error(`Cannot extract JSON from response: ${raw.slice(0, 120)}`);
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  generateQuizPool,
  selectQuestionsAdaptive,
  processAdaptiveResult,
  extractJSON,
};