const express = require('express');
const cors = require('cors');
const responseHandler = require('./middlewares/responseHandler');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(responseHandler); // Đảm bảo luôn có res.success/res.error


// 2. Nạp responseHandler (Phải nạp TRƯỚC các routes)
app.use(responseHandler);


// Định nghĩa Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/plan', require('./routes/planRoutes'));
app.use('/api/ai', require('./routes/aiRoutes'));
app.use('/api/file', require('./routes/fileRoutes'));
app.use('/api/quiz', require('./routes/quizRoutes'));
app.use('/api/assignment', require('./routes/assignmentRoutes'));
app.use('/api/enrollment', require('./routes/enrollmentRoutes'));
app.use('/api/attempt', require('./routes/attemptRoutes'));
app.use('/api/document', require('./routes/documentRoutes'));



// 4. Middleware xử lý lỗi cuối cùng (Global Error Handler)
// Đây là nơi app.use thực sự hoạt động
app.use((err, req, res, next) => {
    console.error("🔥 Hệ thống gặp lỗi:", err.stack);
    
    // Sử dụng res.error đã định nghĩa ở trên
    if (res.error) {
        return res.error(err.message || "Lỗi Server", err.status || 500);
    }
    
    // Dự phòng nếu res.error chưa kịp định nghĩa
    res.status(500).json({
        success: false,
        message: err.message || "Lỗi hệ thống nghiêm trọng"
    });
});

module.exports = app;