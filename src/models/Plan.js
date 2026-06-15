// =========================================================================
// 🗄️ FILE: src/models/Plan.js - BẢN THIẾT KẾ LỘ TRÌNH HỌC (PLAN MODEL)
// Tác dụng: Định nghĩa cấu trúc của một Lộ trình học trong MongoDB.
// Luồng đi: Được tạo bởi finalizeCreateCourse() sau khi AI sinh xong nội dung.
// =========================================================================
const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  // 🏷️ Tên khóa học (thường lấy từ tên file tài liệu người dùng tải lên)
  title: { type: String, required: true },
  topic: String,

  // 👤 Chủ sở hữu: Học viên đã tạo ra lộ trình này
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // 👨‍🏫 Giáo viên hướng dẫn (Học viên chọn khi tạo)
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // 📅 Số ngày học (tối thiểu 1, tối đa 14)
  duration: { type: Number, default: 7 },

  // ⭐ Cấp độ khó của khóa học (hiển thị trên Marketplace)
  // ✅ FIX: Trường 'level' trước đây bị định nghĩa 2 lần trong schema (lỗi cũ).
  // Mongoose sẽ dùng định nghĩa cuối cùng → gây ra hành vi không nhất quán.
  // Đã giữ lại 1 định nghĩa duy nhất ở đây.
  level: {
    type: String,
    enum: ["Easy", "Medium", "Hard", "Basic", "Advanced"],
    default: "Medium"
  },

  // 🎬 Video bài giảng tổng quan của khóa học (tùy chọn)
  videoUrl: { type: String, default: null },

  // 🎯 Mục tiêu học tập: 'theory' (nghiên cứu lý thuyết) hoặc 'practice' (thực hành)
  learningGoals: {
    focus: { type: String, enum: ['theory', 'practice'], default: 'theory' },
    depth: { type: String, enum: ['basic', 'deep', 'advanced'], default: 'basic' }
  },

  // 📝 Mô tả ngắn về khóa học
  description: String,

  // 📦 Nguồn gốc khóa học:
  // 'self'          → Học viên tự tạo bằng AI từ tài liệu của mình
  // 'imported'      → Sao chép về từ Marketplace hoặc link chia sẻ
  // 'assigned'      → Giáo viên được giao hướng dẫn (có instructorId)
  // 'shared_import' → Dạng chia sẻ riêng tư (link private share)
  sourceType: {
    type: String,
    enum: ['self', 'imported', 'assigned', 'shared_import'],
    default: 'self'
  },

  // 🌐 Đăng công khai: true = xuất hiện trên Marketplace
  isPublic: { type: Boolean, default: false },

  // 🏷️ Phân loại & Tag để tìm kiếm trên Marketplace
  categories: [{ type: String }],
  tags: [String],
  normalizedTags: [String], // Phiên bản lowercase/không dấu của tags (dùng khi tìm kiếm)

  // 👥 Danh sách user được chia sẻ riêng tư
  sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // 📊 Trạng thái quản lý nội bộ:
  // 'pending'  → Mới tạo, chưa có giáo viên xem xét
  // 'teaching' → Giáo viên đang dạy (bản clone của GV đang được giữ)
  // 'reviewed' → Giáo viên đã xem qua
  status: {
    type: String,
    enum: ['pending', 'teaching', 'reviewed'],
    default: 'pending'
  },

  // 🗑️ Soft-delete: Đánh dấu xóa thay vì xóa vĩnh viễn khỏi DB
  isDeleted: { type: Boolean, default: false },
  deletedByOwner: { type: Boolean, default: false },
  deletedByInstructor: { type: Boolean, default: false },

  // 📄 Tài liệu gốc người dùng tải lên (lưu text + metadata tại Document model)
  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },

  // 📊 Thông tin kỹ thuật của tài liệu gốc (số từ, có công thức toán không, độ phức tạp)
  documentMetadata: {
    wordCount: { type: Number, default: 0 },
    hasFormulas: { type: Boolean, default: false },
    complexity: { type: String, default: 'medium' },
  },

  // 🎯 Cài đặt học tập được lưu riêng (dự phòng ngoài learningGoals)
  learningFocus: { type: String, enum: ['theory', 'practice'], default: 'theory' },
  learningDepth: { type: String, enum: ['basic', 'deep', 'advanced'], default: 'basic' },

}, { timestamps: true }); // timestamps tự thêm createdAt & updatedAt

module.exports = mongoose.model('Plan', planSchema);