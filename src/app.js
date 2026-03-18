const express = require("express");
const cors = require("cors");
const responseHandler = require("./middlewares/responseHandler");

// --- Import các Routes cũ ---
const authRoutes = require("./routes/authRoutes");
const quizRoutes = require("./routes/quizRoutes");
const attemptRoutes = require("./routes/attemptRoutes");

// --- Import các Routes mới ---
const fileRoutes = require("./routes/fileRoutes"); // Route trích xuất văn bản (PDF, OCR...)
const planRoutes = require("./routes/planRoutes"); // Route tạo lộ trình học tập (Study Plan)
const aiRoutes = require('./routes/aiRoutes'); // Route hỏi đáp AI (Semantic Search + LLM)

//const fileRoutes = require("./routes/fileRoutes");




const courseRoutes = require('./routes/courseRoutes');


const app = express();

// Middleware cơ bản
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(responseHandler); // Đăng ký formatter (res.success, res.error)

// --- Đăng ký các API Endpoints ---

// 1. Hệ thống Auth (Đăng ký, Đăng nhập)
app.use("/api/auth", authRoutes);

// 2. Hệ thống Quiz (Tạo và làm Quiz rời rạc)
app.use("/api/quiz", quizRoutes);

// 3. Hệ thống Lịch sử (Attempts)
app.use("/api/attempt", attemptRoutes);

// 4. Hệ thống xử lý File (Mới - Chuyển PDF/Ảnh thành văn bản)
app.use("/api/file", fileRoutes);

// 5. Hệ thống Lộ trình học tập (Mới - AI Study Plan & Lessons)
app.use("/api/plan", planRoutes);



app.use("/api/ai", aiRoutes);
app.use("/api/course", courseRoutes);
app.use("/api/file", fileRoutes); // Phải có dòng này thì đường dẫn /api/file/extract mới chạy

app.use("/api/plan", planRoutes);


// Health check
app.get("/", (req, res) => res.send("AI Study Assistant API is running..."));

// Middleware xử lý lỗi toàn cục (Global Error Handler)
// Giúp bắt các lỗi như Multer (file quá lớn) hoặc lỗi code mà không làm sập server
app.use((err, req, res, next) => {
    console.error("!!! LỖI HỆ THỐNG:", err.stack);
    
    // Sử dụng res.error từ middleware responseHandler của bạn
    if (res.error) {
        return res.error(err.message || "Internal Server Error", err.status || 500);
    }
    
    // Fallback nếu responseHandler chưa kịp nạp
    res.status(500).json({ 
        success: "false", 
        message: err.message || "Internal Server Error" 
    });
});

module.exports = app;