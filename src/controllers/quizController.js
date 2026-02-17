const Quiz = require("../models/Quiz");
const Attempt = require("../models/Attempt");
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const generateQuiz = async (req, res) => {
  try {
    const { title, topic, numQuestions, difficulty, questionType, timeLimit } =
      req.body;
    const owner = req.user.id;

    // Tạo prompt cho AI
    const prompt = `
    Hệ thống phản hồi dưới dạng JSON thuần túy.
    Không bao gồm markdown, không giải thích, không văn bản thừa.

    Nhiệm vụ:
    Tạo ${numQuestions} câu hỏi trắc nghiệm theo chủ đề "${title}" được mô tả "${topic}" với độ khó "${difficulty}".
    Ngôn ngữ: Tiếng Việt.

    Loại câu hỏi: ${questionType}.

    Các giá trị hợp lệ của questionType:
    - "T/F" → Câu hỏi Đúng/Sai (chỉ có 2 đáp án: ["Đúng", "Sai"])
    - "singleChoice" → Chọn 1 đáp án đúng (4 đáp án)
    - "multipleChoice" → Chọn nhiều đáp án đúng (4 đáp án)
    - "mixed" → Kết hợp nhiều loại câu hỏi trong cùng 1 quiz

    Yêu cầu quan trọng:

    1. Nếu questionType = "T/F"
    - options phải là ["Đúng", "Sai"]
    - correctAnswer là số (0 nếu "Đúng", 1 nếu "Sai")

    2. Nếu questionType = "singleChoice"
    - Có 4 đáp án
    - correctAnswer là số (0-3)

    3. Nếu questionType = "multipleChoice"
    - Có 4 đáp án
    - correctAnswer là mảng số (ví dụ: [0,2])

    4. Nếu questionType = "mixed"
    - Mỗi câu hỏi phải có thêm field "questionType"
    - Mỗi câu sẽ thuộc một trong 3 loại: "T/F", "singleChoice", "multipleChoice"
    - correctAnswer phải đúng theo từng loại

    Cấu trúc JSON phải chính xác như sau:

    {
      "questions": [
        {
          "questionType": "T/F | singleChoice | multipleChoice",
          "text": "Nội dung câu hỏi?",
          "options": ["Đáp án A", "Đáp án B"], // Tối thiểu 2 đáp án, tối đa 4 đáp án tùy loại câu hỏi, các lựa chọn phải khác nhau
          "correctAnswer": 0, // Nếu singleChoice hoặc T/F: số (index của đáp án đúng). Nếu multipleChoice: mảng số (index của các đáp án đúng)
          "explanation": "Giải thích đáp án đúng."
        }
      ]
    }

    Lưu ý:
    - Không thêm bất kỳ văn bản nào ngoài JSON.
    - Không thêm ký tự thừa.
    `;

    // Call API AI
    const completion = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    const aiText = completion.choices[0].message.content;
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const questionsData = JSON.parse(jsonMatch[0]);

    // Lưu trữ quiz vào database
    const newQuiz = new Quiz({
      title,
      numQuestions,
      difficulty,
      questionType,
      timeLimit,
      owner,
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
      difficulty: quiz.difficulty,
      timeLimit: quiz.timeLimit,
      questions: quiz.questions.map((q) => ({
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
      const questionType =
        q.questionType ||
        quiz.questionType ||
        (Array.isArray(q.correctAnswer) ? "multipleChoice" : "singleChoice");

      const isUnanswered =
        userAnswer === null ||
        userAnswer === undefined ||
        (Array.isArray(userAnswer) && userAnswer.length === 0);
      if (isUnanswered) return;

      if (questionType === "T/F" || questionType === "singleChoice") {
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
    const { title, topic, numQuestions, timeLimit, difficulty, questions } =
      req.body;
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
    quiz.numQuestions = numQuestions;
    quiz.timeLimit = timeLimit;
    quiz.difficulty = difficulty;
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
      quiz,
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
