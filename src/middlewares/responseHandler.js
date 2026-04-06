const responseHandler = (req, res, next) => {
  // Hàm gửi phản hồi thành công
    res.success = function (data, message = "Success", statusCode = 200) {
        return res.status(statusCode).json({
            success: true,
            message,
            data,
        });
    };
   // Hàm gửi phản hồi lỗi (Dùng để trả về JSON thay vì [object Object])
    res.error = function (message = "Internal Server Error", statusCode = 500) {
        return res.status(statusCode).json({
            success: false,
            message: typeof message === 'object' ? (message.message || "Lỗi không xác định") : message,
        });
    };

    next();
};

module.exports = responseHandler;
