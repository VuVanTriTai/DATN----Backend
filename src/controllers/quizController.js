const Quiz = require("../models/Quiz");
const Attempt = require("../models/Attempt");
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

const generateQuiz = async (req, res) => {
  try {
    const { title, topic, numQuestions, difficulty, questionType, timeLimit, maxAttempts } =
      req.body;
    const owner = req.user.id;

    // Tạo prompt cho AI
    const prompt = `
      Hệ thống phản hồi dưới dạng JSON thuần túy.
      Không bao gồm markdown, không giải thích, không văn bản thừa.

      Nhiệm vụ:
      Tạo ${numQuestions} câu hỏi trắc nghiệm theo chủ đề "${title}" có nội dung "${topic}" với độ khó "${difficulty}".
      Ngôn ngữ: Tiếng Việt.

      Loại câu hỏi: ${questionType}.

      Các giá trị hợp lệ của questionType:

      1. "multipleStatements":
      - Câu hỏi phải chứa đúng 4 mệnh đề được đánh số 1., 2., 3., 4. (hãy thiết kế các mệnh đề đúng và sai xen kẽ), ví dụ:
        "1. 1+1=2
        2. 2+3=6
        3. 3+3=9
        4. 4+4=8"
      - 4 mệnh đề phải nằm trong field "text".
      - Các phương án trả lời phải là tổ hợp của các mệnh đề, ví dụ:
        "1 và 3 đúng"
        "1, 2 và 4 đúng"
        "Chỉ 2 sai"
        "Cả 4 mệnh đề đều đúng"
      - Có đúng 4 options.
      - Chỉ có 1 đáp án hoàn toàn chính xác.
      - correctAnswer là số từ 0 đến 3.

      2. "singleChoice":
      - Câu hỏi bình thường.
      - Có đúng 4 options.
      - Chỉ có 1 đáp án đúng.
      - correctAnswer là số từ 0 đến 3.

      3. "multipleChoice":
      - Có đúng 4 options.
      - Có thể có nhiều đáp án đúng.
      - correctAnswer là mảng số (ví dụ: [0,2]).

      4. "mixed":
      4. Nếu questionType là "mixed":
      - Mỗi câu hỏi phải có field "questionType".
      - Giá trị chỉ được là:
        "singleChoice"
        "multipleChoice"
        "multipleStatements"
      - Không được dùng "mixed" trong questionType của câu hỏi.

      Cấu trúc JSON bắt buộc:

      {
        "questions": [
          {
            "questionType": "multipleStatements | singleChoice | multipleChoice",
            "text": "Nội dung câu hỏi (nếu multipleStatements phải chứa 4 mệnh đề đánh số 1.,2.,3.,4.)",
            "options": ["Đáp án A", "Đáp án B", "Đáp án C", "Đáp án D"],
            "correctAnswer": 0,
            "explanation": "Giải thích rõ vì sao đáp án đúng."
          }
        ]
      }

      Quy tắc bắt buộc:
      - Text phải chứa đúng 4 mệnh đề.
      - Mỗi mệnh đề phải bắt đầu bằng:
        1.
        2.
        3.
        4.
      - Mỗi mệnh đề phải nằm trên một dòng riêng.
      - Không được tạo ít hơn hoặc nhiều hơn 4 mệnh đề.
      - Explanation phải nhất quán với correctAnswer.
      - Không được tự mâu thuẫn logic toán học hoặc kiến thức cơ bản.
      - Không thêm bất kỳ văn bản nào ngoài JSON.
      - Không thêm ký tự thừa.
    `;


    // Call API AI
    const completion = await client.chat.completions.create({
      model: "gemini-3-flash-preview",
      messages: [{ role: "user", content: prompt }],
      // temperature: 0.7,
    });

    const aiText = completion.choices[0].message.content;
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const questionsData = JSON.parse(jsonMatch[0]);

    // Lưu trữ quiz vào database
    const newQuiz = new Quiz({
      title,
      topic,
      numQuestions,
      difficulty,
      questionType,
      timeLimit,
      owner,
      maxAttempts,
      questions: questionsData.questions,
    });
    await newQuiz.save();

    res.status(201).json({ success: true, quizId: newQuiz._id });
  } catch (error) {
    console.error("Generate quiz error:", error);
    res
      .status(500)
      .json({ success: false, message: "Lỗi khi tạo quiz bằng AI" });
  }
};

const getAllQuizzes = async (req, res) => {
  try {
    const quizzes = await Quiz.find({ owner: req.user.id });
    res.status(200).json(quizzes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getQuizById = async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
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
    const quiz = await Quiz.findById(req.params.id);
    if (!quiz)
      return res
        .status(404)
        .json({ success: false, message: "Quiz không tìm thấy" });

    res.status(200).json({
      id: quiz._id,
      title: quiz.title,
      topic: quiz.topic,
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
    const quiz = await Quiz.findById(req.params.id);
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
      attemptNumber,
      duration,
      answers,
      score,
      totalQuestions: total,
    });

    res.status(200).json({
      success: true,
      attemptNumber,
      score,
      total,
      duration,
      attemptId: attempt._id,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateQuiz = async (req, res) => {
  try {
    const { title, topic, timeLimit, difficulty, maxAttempts, questions } = req.body;
    const quiz = await Quiz.findById(req.params.id);
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
    quiz.topic = topic;
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
    const quiz = await Quiz.findById(req.params.id);
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

module.exports = {
  generateQuiz,
  getQuizById,
  getQuizPublic,
  getAllQuizzes,
  submitQuiz,
  updateQuiz,
  startQuiz,
};
