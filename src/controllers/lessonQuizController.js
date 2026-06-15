// controllers/lessonQuizController.js
"use strict";

const lessonQuizService = require("../services/lessonQuizService");
const Lesson   = require("../models/Lesson");
const Progress = require("../models/Progress");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lesson-quiz/:lessonId/generate-pool
// Sinh pool câu hỏi cho bài học
// ─────────────────────────────────────────────────────────────────────────────
const generatePool = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const questions    = await lessonQuizService.generateQuizPool(lessonId);
    return res.success(
      { count: questions.length },
      `Đã sinh ${questions.length} câu vào quiz pool.`
    );
  } catch (error) {
    console.error("[lessonQuizController] generatePool:", error.message);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lesson-quiz/:lessonId/questions?numQuestions=10
// Lấy câu hỏi thích nghi (ẨN đáp án trước khi nộp)
// ─────────────────────────────────────────────────────────────────────────────
const getAdaptiveQuestions = async (req, res) => {
  try {
    const { lessonId }          = req.params;
    const { numQuestions = 10 } = req.query;
    const userId                = req.user.id;

    const lesson = await Lesson.findById(lessonId).lean();
    if (!lesson) return res.error("Không tìm thấy bài học", 404);

    const progress  = await Progress.findOne({ userId, planId: lesson.planId });
    const userLevel = progress?.currentLevel || "INTERMEDIATE";

    const questions = await lessonQuizService.selectQuestionsAdaptive(
      lessonId,
      userLevel,
      Number(numQuestions)
    );

    // Ẩn correctAnswer và explanation trước khi gửi về client
    const safeQuestions = questions.map((q, idx) => ({
      index:        idx,
      question:     q.question,
      options:      q.options,
      difficulty:   q.difficulty,
      bloomLevel:   q.bloomLevel,
      questionType: q.questionType || "singleChoice",
    }));

    return res.success({ questions: safeQuestions, userLevel, total: safeQuestions.length });
  } catch (error) {
    console.error("[lessonQuizController] getAdaptiveQuestions:", error.message);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/lesson-quiz/:lessonId/submit-adaptive
// Nộp bài → chấm điểm → mở bài tiếp
// Body: { planId, dayNumber, answers: [{poolIndex, answer}, ...] }
// ─────────────────────────────────────────────────────────────────────────────
const submitAdaptive = async (req, res) => {
  try {
    const { lessonId }                   = req.params;
    const { planId, dayNumber, answers } = req.body;
    const userId                         = req.user.id;

    if (!planId || dayNumber === undefined || !Array.isArray(answers)) {
      return res.error("Thiếu planId, dayNumber hoặc answers", 400);
    }

    const lesson = await Lesson.findById(lessonId).lean();
    if (!lesson) return res.error("Không tìm thấy bài học", 404);

    // ── Lấy quiz pool (có fallback tự sinh) ──────────────────────────────────
    let pool = lesson.quizPool || [];

    if (pool.length === 0) {
      console.log(`[submitAdaptive] Pool rỗng → tự sinh cho lesson ${lessonId}`);
      try {
        pool = await lessonQuizService.generateQuizPool(lessonId);
      } catch (genErr) {
        console.warn("[submitAdaptive] generateQuizPool thất bại:", genErr.message);
      }
    }

    // Fallback sang quiz cũ nếu vẫn không có pool
    if (pool.length === 0 && lesson.quiz?.length > 0) {
      pool = lesson.quiz;
    }

    if (pool.length === 0) {
      return res.error("Bài học chưa có nội dung quiz. Vui lòng thử lại sau.", 400);
    }

    // ── Chuẩn hoá answers ────────────────────────────────────────────────────
    // Format mới:  [{poolIndex, answer}, ...]
    // Format cũ:  [number, ...] (sparse array, -1 = không trả lời)
    let normalizedAnswers;

    const isNewFormat =
      answers.length > 0 &&
      typeof answers[0] === "object" &&
      answers[0] !== null &&
      "poolIndex" in answers[0];

    if (isNewFormat) {
      normalizedAnswers = answers.map((a) => ({
        poolIndex: Number(a.poolIndex),
        answer:    Number(a.answer),
      }));
    } else {
      normalizedAnswers = answers
        .map((ans, idx) => ({ poolIndex: idx, answer: Number(ans) }))
        .filter((a) => a.answer !== -1);
    }

    // ── Chấm điểm ────────────────────────────────────────────────────────────
    let correct = 0;
    const detailedResults = normalizedAnswers.map(({ poolIndex, answer }) => {
      const q = pool[poolIndex];
      if (!q) return { isCorrect: false, explanation: "", difficulty: "medium" };
      const isCorrect = answer === Number(q.correctAnswer);
      if (isCorrect) correct++;
      return {
        question:      q.question,
        userAnswer:    answer,
        correctAnswer: Number(q.correctAnswer),
        isCorrect,
        explanation:   q.explanation || "",
        difficulty:    q.difficulty  || "medium",
        questionType:  q.questionType || "singleChoice",
      };
    });

    const total      = normalizedAnswers.length;
    const percentage = total > 0 ? Math.round((correct / total) * 100) : 0;

    // ── Cập nhật Progress ────────────────────────────────────────────────────
    const progress  = await Progress.findOne({ userId, planId });
    const prevAvg   = progress?.averageScore    || 0;
    const prevTotal = progress?.totalQuizzesDone || 0;
    const newTotalQ = prevTotal + 1;
    let   newAvg    = ((prevAvg * prevTotal) + percentage) / newTotalQ;
    if (isNaN(newAvg)) newAvg = percentage;

    const currentLevel =
      newAvg >= 85 ? "EXPERT" :
      newAvg <  60 ? "BEGINNER" : "INTERMEDIATE";

    await Progress.findOneAndUpdate(
      { userId, planId },
      {
        $set: {
          averageScore:     Math.round(newAvg),
          totalQuizzesDone: newTotalQ,
          currentLevel,
        },
        $addToSet: { completedDays: Number(dayNumber) },
        $pull:     { knowledgeMap:  { topic: lesson.title } },
      },
      { upsert: true }
    );
    await Progress.findOneAndUpdate(
      { userId, planId },
      { $push: { knowledgeMap: { topic: lesson.title, score: percentage } } }
    );

    await Lesson.findByIdAndUpdate(lessonId, { status: "completed" });

    // ── Mở bài tiếp + trả kết quả ────────────────────────────────────────────
    const adaptive = await lessonQuizService.processAdaptiveResult(
      userId, planId, dayNumber, percentage, lessonId
    );

    return res.success(
      { score: correct, total, percentage, currentLevel, detailedResults, adaptive },
      "Nộp bài thành công!"
    );
  } catch (error) {
    console.error("[lessonQuizController] submitAdaptive:", error);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lesson-quiz/scores/:planId
// Lấy lịch sử điểm từng bài học của plan
// ─────────────────────────────────────────────────────────────────────────────
const getLessonScores = async (req, res) => {
  try {
    const { planId } = req.params;
    const userId     = req.user.id;

    const progress = await Progress.findOne({ userId, planId });
    return res.success({
      lessonScores: progress?.lessonScores  || [],
      currentLevel: progress?.currentLevel  || "INTERMEDIATE",
      averageScore: progress?.averageScore  || 0,
    });
  } catch (error) {
    return res.error(error.message, 500);
  }
};

module.exports = { generatePool, getAdaptiveQuestions, submitAdaptive, getLessonScores };
