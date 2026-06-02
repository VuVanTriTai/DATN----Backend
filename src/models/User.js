// =========================================================================
// 🗄️ FILE: src/models/User.js - BẢN THIẾT KẾ CƠ SỞ DỮ LIỆU (DATABASE MODEL)
// Tác dụng: Định nghĩa cấu trúc của bảng "User" (người dùng) trong MongoDB.
// Luồng đi: Dữ liệu từ Controller gửi xuống sẽ được Model này xác thực và lưu vào DB.
// =========================================================================

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  // 📧 Email dùng làm tên đăng nhập: Yêu cầu bắt buộc, không được trùng nhau, tự động chuyển về viết thường
  email: { type: String, required: true, unique: true, lowercase: true },
  
  // 🔑 Mật khẩu dạng chuỗi: Bắt buộc nhập (Sẽ được mã hóa trước khi lưu thực tế)
  password: { type: String, required: true },
  
  // 📛 Họ và tên hiển thị của người học hoặc giảng viên
  fullName: { type: String, required: true },
  
  // 🎭 Quyền hạn: Lưu dưới dạng mảng [] vì một người có thể vừa là "learner" vừa là "instructor"
  role: { 
    type: [String], 
    enum: ["learner", "instructor", "admin"], 
    default: "learner" 
  },
  
  // 🚫 Trạng thái hoạt động: Nếu true thì middleware verifyToken sẽ chặn không cho đăng nhập
  isBanned: { type: Boolean, default: false },
  
  // 👨‍🏫 Thông tin bổ sung dành riêng cho Giảng viên (chỉ điền khi là instructor)
  instructorProfile: {
    specialization: String, // Chuyên môn
    bio: String,            // Tiểu sử/Giới thiệu ngắn
    teachingFields: [{ type: String }], // Lĩnh vực dạy (mảng chữ, vd: ['SQL', 'Python'])
    avgRating: { type: Number, default: 0 },    // Điểm đánh giá trung bình
    ratingCount: { type: Number, default: 0 }   // Số lượt đánh giá
  },
  
  // 📚 Sở thích học tập (dành cho Học viên)
  learningPreferences: {
    level: { type: String, default: "NORMAL" }, // Cấp độ muốn học
    interests: [{ type: String }]               // Lĩnh vực quan tâm
  },
  
  // 🔑 Token dự phòng dùng để làm mới phiên đăng nhập mà không cần nhập lại mật khẩu
  refreshToken: String
}, { 
  timestamps: true // Tự động tạo thêm 2 cột: createdAt (ngày tạo) và updatedAt (ngày sửa)
});

// ⚡ MIDDLEWARE HOOK TRƯỚC KHI LƯU (Pre-save):
// Tác dụng: Tự động chạy ngay trước khi dữ liệu được ghi vào ổ đĩa Database
userSchema.pre("save", async function (next) {
  // Nếu mật khẩu không có sự thay đổi (ví dụ cập nhật profile thường), chuyển tiếp luôn
  if (!this.isModified("password")) return next();
  
  // 🔐 Tiến hành băm (hash) bảo mật mật khẩu với độ phức tạp là 10 vòng mã hóa
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

module.exports = mongoose.model("User", userSchema);