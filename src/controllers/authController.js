// =========================================================================
// 👨‍🍳 FILE: src/controllers/authController.js - BỘ XỬ LÝ LOGIC XÁC THỰC (AUTH CONTROLLER)
// Tác dụng: Là nơi thực thi toàn bộ logic nghiệp vụ liên quan đến Tài khoản (Xác thực, Mã hóa, Cấp token).
// Luồng đi: Nhận yêu cầu từ Router -> Đọc/Ghi dữ liệu qua Model -> Trả kết quả JSON về cho Frontend.
// =========================================================================

const User = require("../models/User");
const bcrypt = require("bcryptjs");
const { generateToken } = require("../utils/jwtHelper");
const jwt = require("jsonwebtoken");
const axios = require("axios");

/**
 * 1. ĐĂNG KÝ TÀI KHOẢN (Register)
 * Luồng chạy: Nhận Body -> Validate -> Kiểm trùng Email -> Hash mật khẩu (Pre-save Hook) -> Lưu DB
 */
const register = async (req, res) => {
    console.log("Dữ liệu đăng ký nhận được:", req.body);
    try {
        // BƯỚC 1: Lấy dữ liệu gửi lên từ thân (body) của Request
        const { email, password, fullName, role } = req.body;

        // BƯỚC 2: Kiểm tra dữ liệu đầu vào xem có bị trống trường nào bắt buộc không
        if (!email || !password || !fullName) {
            return res.status(400).json({ success: false, message: "Thiếu thông tin bắt buộc." });
        }

        // BƯỚC 3: Truy vấn DB tìm xem email đăng ký này đã tồn tại hay chưa
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ success: false, message: "Email này đã tồn tại." });

        // BƯỚC 4: Chuẩn hóa vai trò người dùng (Tài khoản mặc định luôn có quyền 'learner')
        const userRoles = ['learner'];
        
        // Nếu người dùng chủ động chọn vai trò là giảng viên khi đăng ký, cấp thêm quyền 'instructor'
        if (role === 'instructor') {
            userRoles.push('instructor');
        }

        // BƯỚC 5: Gọi Model User để khởi tạo một tài khoản mới và lưu xuống MongoDB
        // Lưu ý: Password sẽ được pre-save hook của Model mã hóa tự động trước khi ghi vào ổ đĩa.
        const user = await User.create({ 
            email: email.toLowerCase(),
            password: password, 
            fullName: fullName,
            role: userRoles 
        });

        // BƯỚC 6: Trả về kết quả đăng ký thành công cho trình duyệt
        return res.success({ id: user._id, fullName: user.fullName, role: user.role }, "Đăng ký thành công!");
    } catch (error) {
        console.error("Lỗi Mongoose Register:", error);
        return res.error(error.message, 500);
    }
};

/**
 * 2. ĐĂNG NHẬP (Login)
 * Luồng chạy: Nhận Body -> Tìm User -> So sánh mật khẩu băm -> Tạo JWT Tokens -> Lưu DB -> Trả về Client
 */
const login = async (req, res) => {
    try {
        // BƯỚC 1: Nhận Email và Mật khẩu từ Frontend gửi lên
        const { email, password } = req.body;
        
        // BƯỚC 2: Truy tìm tài khoản có email trùng khớp trong database
        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ success: false, message: "Tài khoản không tồn tại." });

        // BƯỚC 3: Giải mã mật khẩu băm và so sánh mật khẩu nhập vào bằng thư viện bcrypt
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Mật khẩu không chính xác." });

        // BƯỚC 4: Tạo cặp chứng thư xác thực JWT (Token):
        // 💎 Access Token: Hạn ngắn (1 ngày) dùng để chứng thực danh tính cho mỗi request gọi API bảo mật.
        const accessToken = generateToken(
            { id: user._id, role: user.role }, 
            process.env.ACCESS_TOKEN_SECRET, 
            "1d"
        );
        // 💎 Refresh Token: Hạn dài (7 ngày) dùng để xin cấp mới Access Token mà không cần đăng nhập lại.
        const refreshToken = generateToken(
            { id: user._id }, 
            process.env.REFRESH_TOKEN_SECRET, 
            "7d"
        );

        // BƯỚC 5: Lưu Refresh Token vào Database để đối chiếu xác thực phiên làm việc sau này
        user.refreshToken = refreshToken;
        await user.save();

        // BƯỚC 6: Trả về cặp Token và thông tin người dùng cơ bản cho Frontend lưu trữ và sử dụng
        return res.success({
            accessToken,
            refreshToken,
            user: { id: user._id, fullName: user.fullName, role: user.role }
        }, "Đăng nhập thành công.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 3. LÀM MỚI TOKEN (Refresh Token)
 */
const refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.error("Không tìm thấy Refresh Token", 400);

        const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
        const user = await User.findById(decoded.id);

        if (!user || user.refreshToken !== refreshToken) {
            return res.error("Token không hợp lệ hoặc đã hết hạn", 403);
        }

        const newAccessToken = generateToken(
            { id: user._id, role: user.role }, 
            process.env.ACCESS_TOKEN_SECRET, 
            "1d"
        );

        return res.success({ accessToken: newAccessToken }, "Token đã được làm mới.");
    } catch (error) {
        return res.error("Phiên đăng nhập hết hạn", 403);
    }
};

/**
 * 4. LẤY THÔNG TIN CÁ NHÂN (Get Me)
 */
// Luồng chạy: Nhận yêu cầu có kèm Access Token 
// -> Middleware verifyToken giải mã và gắn user ID vào req.user.id
// -> Controller dùng ID này để truy vấn thông tin người dùng trong DB và trả về cho Frontend
const getMe = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select("-password -refreshToken");
        return res.success(user);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 5. CẬP NHẬT HỒ SƠ
 */
// Luồng chạy: Nhận Body -> Tìm User -> Cập nhật thông tin -> Lưu DB -> Trả về kết quả
// Lưu ý: Người dùng chỉ có thể cập nhật họ tên và thông tin giảng viên (nếu có),
//  không được phép thay đổi email hoặc vai trò trong chức năng này.
const updateProfile = async (req, res) => {
    try {
        // Lấy họ tên mới và thông tin giảng viên từ body gửi lên
        const { fullName, instructorProfile } = req.body;
        
        // Tìm và cập nhật thông tin người dùng dựa vào ID đã được 
        // middleware verifyToken gắn vào req.user.id
        const user = await User.findByIdAndUpdate(
            req.user.id,
            { fullName, instructorProfile },
            { new: true }
            // Sau khi cập nhật xong, trả về thông tin user mới nhất 
            // (đã loại bỏ trường password và refreshToken) 
            // để frontend cập nhật giao diện
        ).select("-password -refreshToken");

        return res.success(user, "Cập nhật hồ sơ thành công.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 6. ĐỔI MẬT KHẨU
 * 
 */
// Luồng chạy: Nhận Body -> Tìm User -> So sánh mật khẩu cũ -> Gán mật khẩu mới 
// -> Lưu DB (Pre-save Hook sẽ hash tự động)
// Lưu ý: Người dùng phải cung cấp đúng mật khẩu cũ mới được phép đổi sang mật khẩu mới.
const changePassword = async (req, res) => {
    try {
        //lấy mật khẩu cũ và mới từ body
        const { oldPassword, newPassword } = req.body;
        //tìm user hiện tại trong DB dựa vào ID đã được middleware verifyToken gắn vào req.user.id
        const user = await User.findById(req.user.id);
//so sánh mật khẩu cũ nhập vào với mật khẩu đã được băm lưu trong DB
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        //nếu không khớp, trả về lỗi
        if (!isMatch) return res.status(400).json({ success: false, message: "Mật khẩu cũ không đúng." });
//nếu khớp, gán mật khẩu mới cho user.password (sẽ được tự động hash bởi pre-save hook trong model) và lưu lại
        user.password = newPassword; // Sẽ được tự động hash bởi pre-save hook trong model
        // Lưu lại user với mật khẩu mới đã được hash
        await user.save();

        return res.success(null, "Đổi mật khẩu thành công.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 7. LẤY DANH SÁCH GIÁO VIÊN (Cho Learner chọn)
 */
const getInstructors = async (req, res) => {
  try {
    // Tìm những user mà trong mảng role có chứa phần tử "instructor"
    const instructors = await User.find({ 
      role: "instructor" 
    }).select("fullName email instructorProfile");

    return res.success(instructors);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

//8. TÌM KIẾM NGƯỜI DÙNG THEO EMAIL HOẶC HỌ TÊN 
// (Dành cho Admin hoặc Instructor muốn tìm học viên hoặc đồng nghiệp)
// Luồng chạy: Nhận query param -> Chuẩn hóa -> Tìm kiếm trong DB -> Trả kết quả
// Lưu ý: Tìm kiếm sẽ khớp chính xác email hoặc họ tên (không phân biệt hoa thường)
// Ví dụ: /api/auth/search?email=nguyen van a 
// -> sẽ tìm kiếm người dùng có email hoặc fullName trùng khớp "nguyen van a"
// SỬA LẠI: Tìm kiếm hoặc là khớp Email, hoặc là khớp Họ tên (không phân biệt hoa thường)
const searchUser = async (req, res) => {
  try {
    const { email } = req.query; // email này là chuỗi người dùng nhập vào ô search
    if (!email) return res.error("Vui lòng nhập thông tin tìm kiếm", 400);

    const searchKey = email.toLowerCase().trim();

    // SỬA LẠI: Tìm kiếm hoặc là khớp Email, hoặc là khớp Họ tên
    const user = await User.findOne({
      $or: [
        { email: searchKey },
        { fullName: { $regex: new RegExp("^" + searchKey + "$", "i") } } 
      ]
    }).select("fullName email role");

    if (!user) {
      return res.status(404).json({ success: false, message: "Không tìm thấy người dùng này!" });
    }

    return res.success(user);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * 9. ĐĂNG NHẬP BẰNG GOOGLE
 */
const googleLogin = async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ success: false, message: "Thiếu Google Token." });
        }

        // Gọi API của Google để xác thực ID Token
        const googleResponse = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
        const payload = googleResponse.data;

        // Kiểm tra tính hợp lệ của token
        if (!payload.email) {
            return res.status(400).json({ success: false, message: "Token Google không hợp lệ hoặc đã hết hạn." });
        }

        const email = payload.email.toLowerCase();
        const fullName = payload.name || "Google User";

        // Tìm user theo email
        let user = await User.findOne({ email });

        if (!user) {
            // Tạo tài khoản mới nếu chưa tồn tại
            const randomPassword = Math.random().toString(36).slice(-10) + 'A1!'; // Mật khẩu ngẫu nhiên để vượt qua validate
            user = await User.create({
                email,
                fullName,
                password: randomPassword,
                role: ['learner']
            });
        }

        // Tạo accessToken và refreshToken
        const accessToken = generateToken(
            { id: user._id, role: user.role }, 
            process.env.ACCESS_TOKEN_SECRET, 
            "1d"
        );
        const refreshToken = generateToken(
            { id: user._id }, 
            process.env.REFRESH_TOKEN_SECRET, 
            "7d"
        );

        user.refreshToken = refreshToken;
        await user.save();

        return res.success({
            accessToken,
            refreshToken,
            user: { id: user._id, fullName: user.fullName, role: user.role }
        }, "Đăng nhập Google thành công.");
    } catch (error) {
        console.error("Lỗi xác thực Google Token:", error.message);
        return res.status(400).json({ success: false, message: "Xác thực Google thất bại hoặc Token hết hạn." });
    }
};

/**
 * 10. ĐĂNG KÝ VAI TRÒ GIÁO VIÊN
 */
const registerInstructor = async (req, res) => {
    try {
        const { specialization, bio, teachingFields } = req.body;
        
        // Tìm user hiện tại
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "Không tìm thấy người dùng." });
        }

        // Kiểm tra xem đã là giảng viên chưa
        if (user.role.includes("instructor")) {
            return res.status(400).json({ success: false, message: "Tài khoản của bạn đã là Giảng viên rồi." });
        }

        // Cập nhật vai trò và thông tin giảng viên
        user.role.push("instructor");
        user.instructorProfile = {
            specialization: specialization || "",
            bio: bio || "",
            teachingFields: Array.isArray(teachingFields) ? teachingFields : (teachingFields ? teachingFields.split(",").map(t => t.trim()) : [])
        };

        // Tạo lại token mới chứa role mới
        const accessToken = generateToken(
            { id: user._id, role: user.role }, 
            process.env.ACCESS_TOKEN_SECRET, 
            "1d"
        );
        const refreshToken = generateToken(
            { id: user._id }, 
            process.env.REFRESH_TOKEN_SECRET, 
            "7d"
        );

        user.refreshToken = refreshToken;
        await user.save();

        return res.success({
            accessToken,
            refreshToken,
            user: { 
                id: user._id, 
                fullName: user.fullName, 
                email: user.email,
                role: user.role,
                instructorProfile: user.instructorProfile
            }
        }, "Đăng ký vai trò Giảng viên thành công!");
    } catch (error) {
        console.error("Lỗi đăng ký giảng viên:", error);
        return res.error(error.message, 500);
    }
};

// EXPORT TOÀN BỘ ĐỂ ROUTES SỬ DỤNG
module.exports = { 
    register, 
    login, 
    refreshToken, 
    getMe, 
    updateProfile, 
    changePassword, 
    getInstructors ,
    searchUser,
    googleLogin,
    registerInstructor
};