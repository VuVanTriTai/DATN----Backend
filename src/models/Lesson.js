// =========================================================================
// 🗄️ FILE: src/models/Lesson.js - BẢN THIẾT KẾ BÀI HỌC (LESSON MODEL)
// Tác dụng: Định nghĩa cấu trúc của từng ngày học (bài giảng, tóm tắt, câu hỏi trắc nghiệm, bài tập).
// Luồng đi: Được sinh ra từ planService khi tạo khóa học, hoặc nhân bản khi Giáo viên chỉnh sửa.
// =========================================================================

const mongoose = require('mongoose');

// 📝 SCHEMA CON: Định nghĩa một câu hỏi trắc nghiệm trong ngân hàng câu hỏi (quizPool)
const QuizPoolItem = new mongoose.Schema({
  question:      { type: String, required: true }, // Nội dung câu hỏi
  options:       [{ type: String }],               // 4 đáp án lựa chọn
  correctAnswer: { type: Number, required: true }, // Index của đáp án đúng (0, 1, 2, 3)
  explanation:   { type: String, default: '' },    // Lời giải thích tại sao đúng
  difficulty:    { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' }, // Độ khó
  bloomLevel:    { type: String, default: 'Thông hiểu' }, // Thang đo Bloom (Biết, Hiểu, Vận dụng,...)
}, { _id: false });

const lessonSchema = new mongoose.Schema({
    // 🔗 Khóa ngoại tham chiếu đến Lộ trình cha (Plan) chứa bài học này
    planId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    
    // 📅 Ngày học thứ mấy trong lộ trình (Ví dụ: Ngày 1, Ngày 2,...)
    dayNumber: { type: Number, required: true },
    
    // 🏷️ Tiêu đề bài học
    title:   String,
    
    // 📖 Nội dung bài giảng đầy đủ (lưu dưới dạng Markdown để hiển thị đẹp ở FE)
    content: { type: String, required: true },
    
    // 📝 Tóm tắt ngắn gọn bài học
    summary: String,
    
    // 📌 Những điểm lưu ý quan trọng cần ghi nhớ
    importantNotes: [String],

    // ── TÍNH NĂNG TƯƠNG TÁC CỦA GIÁO VIÊN (Instructor Features) ──────
    videoUrl: { type: String, default: null },       // Link video bài giảng từ YouTube
    assignmentUrl: { type: String, default: null },  // Đường dẫn file bài tập tự luận do giáo viên tải lên
    solutionUrl: { type: String, default: null },    // Đường dẫn file lời giải cho bài tập tự luận
    // ──────────────────────────────────────────────────────────

    // Mảng quiz cũ (hỗ trợ tương thích ngược)
    quiz: [mongoose.Schema.Types.Mixed],

    // ── HỌC TẬP THÍCH ỨNG (Adaptive Learning) ───────────────────
    // Ngân hàng câu hỏi trắc nghiệm lớn (20-30 câu). AI sẽ tự động chọn lọc câu hỏi
    // phù hợp nhất với trình độ thực tế của người học để hiển thị làm bài test.
    quizPool: { type: [QuizPoolItem], default: [] },

    // Phân loại bài học:
    // 'main': Bài học chính
    // 'remedial': Bài ôn tập (được mở khi người học làm bài kiểm tra điểm kém)
    // 'advanced': Bài nâng cao (được mở khi người học hoàn thành bài xuất sắc)
    quizType: {
      type: String,
      enum: ['main', 'remedial', 'advanced'],
      default: 'main'
    },

    // Liên kết với bài chính (nếu đây là bài remedial hoặc advanced)
    linkedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },
    // ────────────────────────────────────────────────────────────

    // ── BẢN NHÁP CỦA GIÁO VIÊN (Instructor Draft) ──────────────────
    // Khi Giáo viên thay đổi bài học nhưng chưa muốn học viên thấy ngay, dữ liệu sẽ
    // tạm lưu ở đây. Khi bấm "Gửi học viên", các trường này sẽ được ghi đè lên trường chính.
    instructorDraft: {
      content:        { type: String, default: null },
      summary:        { type: String, default: null },
      importantNotes: { type: [String], default: null },
      quizPool:       { type: [mongoose.Schema.Types.Mixed], default: null },
      videoUrl:       { type: String, default: null },
      assignmentUrl:  { type: String, default: null },
      solutionUrl:    { type: String, default: null },
      savedAt:        { type: Date, default: null },
    },
    hasDraft: { type: Boolean, default: false }, // Đánh dấu bài học này đang có bản nháp chưa merge
    // ────────────────────────────────────────────────────────────────────────

    status: { type: String, enum: ['locked', 'in-progress', 'completed'], default: 'locked' },
    reusedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },
    
    // ── REUSE METADATA ──────────────────────────────────────────
    version: { type: String, default: 'v1' },
    coverage: { type: [String], default: [] },     // Những phần kiến thức bài học này bao quát
    sourceChunks: { type: [String], default: [] }, // Các đoạn text gốc tạo nên bài học này
    
    isDeleted:  { type: Boolean, default: false },
    deleteAt:   { type: Date, default: null },
});

module.exports = mongoose.model('Lesson', lessonSchema);