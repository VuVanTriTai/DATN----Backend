// controllers/quizController.js
const Quiz = require("../models/Quiz");
const Attempt = require("../models/Attempt");
const Groq = require("groq-sdk");
const Lesson = require("../models/Lesson");
const Progress = require("../models/Progress");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });


/**
 * TẠO QUIZ ĐỘC LẬP (Thường dành cho Instructor tạo cho lớp)
 */
const generateQuiz = async (req, res) => {
  try {
    const { title, topic, numQuestions, difficulty } = req.body;
    
    // Sử dụng Prompt chuyên sâu về sư phạm (4 mức độ tư duy)
    const prompt = `Bạn là chuyên gia khảo thí. Hãy tạo bộ câu hỏi trắc nghiệm về: "${topic}".
    YÊU CẦU:
    - Số lượng: ${numQuestions} câu.
    - Độ khó: ${difficulty}.
    - Phân loại mức độ: Nhận biết, Thông hiểu, Vận dụng, Phân tích.
    - Trả về JSON thuần túy, không giải thích.

    CẤU TRÚC JSON:
    {
      "questions": [
        {
          "questionType": "singleChoice",
          "text": "Nội dung câu hỏi",
          "options": ["A", "B", "C", "D"],
          "correctAnswer": 0,
          "explanation": "Giải thích chi tiết",
          "level": "Nhận biết"
        }
      ]
    }`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant", // Ưu tiên bản 8b để tránh lỗi JSON
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const questionsData = JSON.parse(completion.choices[0].message.content);

    const newQuiz = new Quiz({
      title,
      numQuestions,
      difficulty,
      owner: req.user.id,
      questions: questionsData.questions,
    });
    await newQuiz.save();

    return res.success({ quizId: newQuiz._id }, "Tạo bộ câu hỏi thành công.");
  } catch (error) {
    return res.error("Lỗi khi tạo quiz bằng AI", 500);
  }
};

/**
 * CHẤM ĐIỂM QUIZ TRONG BÀI HỌC RAG (Cập nhật tiến độ học viên)
 */
// src/controllers/quizController.js

// src/controllers/quizController.js - Hàm submitLessonQuiz

const submitLessonQuiz = async (req, res) => {
    try {
        const { planId, dayNumber, answers } = req.body;
        const userId = req.user.id;

        const lesson = await Lesson.findOne({ planId, dayNumber });
        if (!lesson) return res.error("Không tìm thấy bài học", 404);

        const total = lesson.quiz ? lesson.quiz.length : 0;
        if (total === 0) return res.success({ score: 0, total: 0 }, "Không có quiz.");

        let score = 0;
        const detailedResults = lesson.quiz.map((q, index) => {
            const isCorrect = Number(answers[index]) === q.correctAnswer;
            if (isCorrect) score++;
            return { question: q.question, isCorrect, explanation: q.explanation };
        });

        const currentScore = (score / total) * 100;

        // CẬP NHẬT TIẾN ĐỘ AN TOÀN (Fix lỗi NaN)
        const progress = await Progress.findOne({ userId, planId });
        
        let prevAverage = progress?.averageScore || 0;
        let prevTotal = progress?.totalQuizzesDone || 0;

        let newTotalQuizzes = prevTotal + 1;
        // Tính toán tránh NaN
        let newAverage = ((prevAverage * prevTotal) + currentScore) / newTotalQuizzes;
        if (isNaN(newAverage)) newAverage = currentScore;

        await Progress.findOneAndUpdate(
            { userId, planId },
            { 
                $set: { averageScore: newAverage, totalQuizzesDone: newTotalQuizzes },
                $addToSet: { completedDays: Number(dayNumber) },
                $pull: { knowledgeMap: { topic: lesson.title } } 
            },
            { upsert: true }
        );

        await Progress.findOneAndUpdate(
            { userId, planId },
            { $push: { knowledgeMap: { topic: lesson.title, score: currentScore } } }
        );

        // Mở khóa bài tiếp theo
        // 1. Đánh dấu hoàn thành bài hiện tại (ĐÚNG)
        await Lesson.findByIdAndUpdate(lesson._id, { status: 'completed' });

        // 2. Mở khóa bài học của ngày tiếp theo (SỬA LẠI TẠI ĐÂY)
        const nextDay = Number(dayNumber) + 1;
        await Lesson.findOneAndUpdate(
            { planId, dayNumber: nextDay, status: 'locked' },
            { status: 'in-progress' } // Sửa từ 'completed' thành 'in-progress'
        );

        return res.success({ score, total, percentage: Math.round(currentScore), detailedResults });
    } catch (error) {
        console.error("Lỗi submit quiz:", error);
        return res.error(error.message, 500);
    }
};

const getAllQuizzes = async (req, res) => {
  try {
    const quizzes = await paginate(
      Quiz,
      { owner: req.user.id, isDeleted: false },
      {
        page: req.query.page,
        limit: req.query.limit,
        select: "-isDeleted -deleteAt",
      },
    );

    if (quizzes.data.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy quiz nào" });
    }

    res.status(200).json(quizzes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getQuizById = async (req, res) => {
  try {
    const quiz = await Quiz.findById({ _id: req.params.id, isDeleted: false }).select("-isDeleted -deleteAt");
    if (!quiz)
      return res
        .status(404)
        .json({ success: false, message: "Quiz không tìm thấy" });

    if (quiz.owner.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: "Không có quyền truy cập quiz này" });
    }

    res.status(200).json(quiz);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getQuizPublic = async (req, res) => {
  try {
    const quiz = await Quiz.findById({ _id: req.params.id, isDeleted: false }).select("-isDeleted -deleteAt");
    if (!quiz)
      return res
        .status(404)
        .json({ success: false, message: "Quiz không tìm thấy" });

    res.status(200).json({
      id: quiz._id,
      title: quiz.title,
      difficulty: quiz.difficulty,
      timeLimit: quiz.timeLimit,
      maxAttempts: quiz.maxAttempts,
      questions: quiz.questions.map((q) => ({
        questionType: q.questionType,
        text: q.text,
        options: q.options,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const submitQuiz = async (req, res) => {
  try {
    const quiz = await Quiz.findById({ _id: req.params.id, isDeleted: false }).select("-isDeleted -deleteAt");
    if (!quiz)
      return res
        .status(404)
        .json({ success: false, message: "Quiz không tìm thấy" });

    const userId = req.user.id;
    const { duration } = req.body;

    const perviousAttempts = await Attempt.find({
      quiz: quiz._id,
      user: userId,
    });
    const attemptNumber = perviousAttempts.length + 1;

    const rawAnswers = req.body?.answers;
    let answers = [];

    if (Array.isArray(rawAnswers)) answers = rawAnswers;
    else if (rawAnswers && typeof rawAnswers === "object") {
      answers = Object.keys(rawAnswers)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => rawAnswers[k]);
    }

    let score = 0;
    quiz.questions.forEach((q, index) => {
      const userAnswer = answers[index];

      const questionType = q.questionType || quiz.questionType;

      const isUnanswered =
        userAnswer === null ||
        userAnswer === undefined ||
        (Array.isArray(userAnswer) && userAnswer.length === 0);
      if (isUnanswered) return;

      if (questionType === "multipleStatements" || questionType === "singleChoice") {
        if (Number(userAnswer) === Number(q.correctAnswer)) score++;
        return;
      }

      if (questionType === "multipleChoice") {
        if (Array.isArray(userAnswer) && Array.isArray(q.correctAnswer)) {
          const sortedUser = [...userAnswer].map(Number).sort((a, b) => a - b);
          const sortedCorrect = [...q.correctAnswer]
            .map(Number)
            .sort((a, b) => a - b);

          if (
            sortedUser.length === sortedCorrect.length &&
            sortedUser.every((val, i) => val === sortedCorrect[i])
          ) {
            score++;
          }
        }
      }
    });

    const total = quiz.questions.length;

    for (let i = 0; i < total; i++) {
      if (answers[i] === undefined) answers[i] = null;
    }

    const attempt = await Attempt.create({
      user: userId,
      quiz: quiz._id,
      quizTitle: quiz.title,
      attemptNumber,
      duration,
      answers,
      score,
      totalQuestions: total,
    });

    res.status(200).json({ success: true, attempt, quiz });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateQuiz = async (req, res) => {
  try {
    const { title, timeLimit = null, difficulty, maxAttempts = null, questions } = req.body;
    const quiz = await Quiz.findById({ _id: req.params.id, isDeleted: false }).select("-isDeleted -deleteAt");
    if (!quiz)
      return res
        .status(404)
        .json({ success: false, message: "Quiz không tìm thấy" });

    if (quiz.owner.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: "Không có quyền chỉnh sửa quiz này" });
    }

    quiz.title = title;
    quiz.numQuestions = questions.length;
    quiz.difficulty = difficulty;
    quiz.timeLimit = timeLimit;
    quiz.maxAttempts = maxAttempts;
    quiz.questions = questions;

    await quiz.save();
    res
      .status(200)
      .json({ success: true, message: "Cập nhật quiz thành công" });
  } catch (error) {
    console.error("Update quiz error:", error);
    res.status(500).json({ success: false, message: "Lỗi khi cập nhật quiz" });
  }
};

const startQuiz = async (req, res) => {
  try {
    const quiz = await Quiz.findById({ _id: req.params.id, isDeleted: false }).select("-isDeleted -deleteAt");
    if (!quiz) {
      return res.status(404).json({
        success: false,
        message: "Quiz không tìm thấy",
      });
    }

    const userId = req.user.id;

    if (quiz.owner.toString() !== userId) {
      // Đếm số lần đã làm
      const attemptCount = await Attempt.countDocuments({
        user: userId,
        quiz: quiz._id,
      });

      if (quiz.maxAttempts && attemptCount >= quiz.maxAttempts) {
        return res.status(403).json({
          success: false,
          message: "Bạn đã hết số lần làm bài",
        });
      }

      res.status(200).json({
        success: true,
        remainingAttempts: quiz.maxAttempts - attemptCount,
        quizId: quiz._id,
      });
    }

    res.status(200).json({
      success: true,
      message: "Chủ sở hữu quiz được phép làm bài vô hạn",
      quizId: quiz._id,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

const deleteQuiz = async (req, res) => {
  try {
    const quiz = await Quiz.findById({ _id: req.params.id, isDeleted: false }).select("-isDeleted -deleteAt");
    if (!quiz)
      return res
        .status(404)
        .json({ success: false, message: "Quiz không tìm thấy" });

    if (quiz.owner.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: "Không có quyền xóa quiz này" });
    }

    quiz.isDeleted = true;
    quiz.deleteAt = new Date();
    await quiz.save();

    const attempts = await Attempt.find({ quiz: quiz._id, isDeleted: false });
    for (const attempt of attempts) {
      attempt.isDeleted = true;
      attempt.deleteAt = new Date();
      await attempt.save();
    }

    res.status(200).json({ success: true, message: "Xóa quiz thành công" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const searchQuizzes = async (req, res) => {
  try {
    const { keyword } = req.query;

    if (!keyword || keyword.trim() === "") {
      return res.status(400).json({ success: false, message: "Keyword không được để trống" });
    }

    const quizzes = await paginate(
      Quiz,
      {
        $text: { $search: keyword },
        private: false,
        isDeleted: false,
      },
      {
        page: req.query.page,
        limit: req.query.limit,
        select: "-isDeleted -deleteAt",
      }
    );

    res.status(200).json({ quizzes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


module.exports = {
  generateQuiz,
  getQuizById,
  getQuizPublic,
  getAllQuizzes,
  submitQuiz,
  updateQuiz,
  startQuiz,
  deleteQuiz,
  searchQuizzes,
  submitLessonQuiz,
};
