const jwt = require("jsonwebtoken");
const User = require("../models/User");

const verifyToken = async (req, res, next) => {
  // 1. Lấy mã Token từ header "Authorization" của request
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];// Tách chữ 
  // "Bearer <Token>" lấy phần sau



  // 2. Không có token? Trả về lỗi 401 (Chưa đăng nhập)
  if (!token) return res.error("Access token required", 401);

  // 3. Giải mã chữ ký Token bằng chìa khóa bí mật ACCESS_TOKEN_SECRET
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, async (err, decoded) => {
    if (err) return res.error("Token invalid or expired", 403);// Token giả hoặc hết hạn

    // Kiểm tra tài khoản có bị ban không
    // 4. Kiểm tra tài khoản trong database xem có bị khóa (banned) không
    const user = await User.findById(decoded.id).select("isBanned");
    if (user?.isBanned) {
      return res.status(403).json({
        success: false,
        message: "Tài khoản của bạn đã bị khóa. Vui lòng liên hệ Admin.",
      });
    }
// 5. Nếu mọi thứ hợp lệ, đính thông tin user vào request (req.user) và cho đi tiếp
    req.user = decoded;
    next();// Chuyển tiếp tới bước xử lý sau (Controller)
  });
};

module.exports = verifyToken;
