const User = require("../models/User");
const bcrypt = require("bcryptjs");
const { generateToken } = require("../utils/jwtHelper");
const jwt = require("jsonwebtoken");

/**
 * 1. ĐĂNG KÝ TÀI KHOẢN
 */
const register = async (req, res) => {
    try {
        const { email, password, fullName, role } = req.body;

        if (!email || !password || !fullName) {
            return res.status(400).json({ success: false, message: "Vui lòng điền đầy đủ thông tin." });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ success: false, message: "Email này đã được sử dụng." });

        const user = await User.create({ 
            email, 
            password, 
            fullName, 
            role: role || "learner" 
        });

        return res.success(
            { id: user._id, fullName: user.fullName, role: user.role }, 
            "Đăng ký thành công!"
        );
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 2. ĐĂNG NHẬP
 */
const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ success: false, message: "Tài khoản không tồn tại." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Mật khẩu không chính xác." });

        // Tạo cặp token
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
const updateProfile = async (req, res) => {
    try {
        const { fullName, instructorProfile } = req.body;
        
        const user = await User.findByIdAndUpdate(
            req.user.id,
            { fullName, instructorProfile },
            { new: true }
        ).select("-password -refreshToken");

        return res.success(user, "Cập nhật hồ sơ thành công.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 6. ĐỔI MẬT KHẨU
 */
const changePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const user = await User.findById(req.user.id);

        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) return res.status(400).json({ success: false, message: "Mật khẩu cũ không đúng." });

        user.password = newPassword; // Sẽ được tự động hash bởi pre-save hook trong model
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
        const instructors = await User.find({ role: "instructor" })
            .select("fullName instructorProfile email")
            .lean();
        return res.success(instructors);
    } catch (error) {
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
    getInstructors 
};