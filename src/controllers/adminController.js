const User = require("../models/User");
const Plan = require("../models/Plan");
const Lesson = require("../models/Lesson");
const bcrypt = require("bcryptjs");

// ============================================================
// 1. DASHBOARD STATISTICS
// ============================================================
const getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);// Lấy mốc thời gian 00:00:00 ngày hôm nay để đếm dữ liệu mới

// Sử dụng Promise.all để chạy song song 8 câu lệnh đếm dữ liệu cho nhanh
    const [
      totalUsers,
      totalCourses,
      totalPublicCourses,
      newUsersToday,
      newCoursesToday,
      totalInstructors,
      totalLearners,
      bannedUsers,
    ] = await Promise.all([
      User.countDocuments({ role: { $ne: "admin" } }),// Đếm tất cả trừ admin ($ne = not equal)
      Plan.countDocuments({ isDeleted: false }), // Đếm lộ trình chưa bị xóa
      Plan.countDocuments({ isPublic: true, isDeleted: false }),// Đếm lộ trình công khai trên chợ
      User.countDocuments({ createdAt: { $gte: today }, role: { $ne: "admin" } }),// $gte = greater than or equal 
      // (lớn hơn hoặc bằng hôm nay)
      Plan.countDocuments({ createdAt: { $gte: today }, isDeleted: false }),
      User.countDocuments({ role: "instructor" }),
      User.countDocuments({ role: "learner" }),
      User.countDocuments({ isBanned: true }),
    ]);

    // Top 5 instructors by rating
    const topInstructors = await User.find({ role: "instructor" })
      .select("fullName email instructorProfile")
      .sort({ "instructorProfile.avgRating": -1 })
      .limit(5);

    // 5 khoá học mới nhất lên Market
    const recentMarketCourses = await Plan.find({ isPublic: true, isDeleted: false })
      .select("title topic categories owner createdAt")
      .populate("owner", "fullName email")
      .sort({ createdAt: -1 })
      .limit(5);

    return res.success({
      stats: {
        totalUsers,
        totalCourses,
        totalPublicCourses,
        newUsersToday,
        newCoursesToday,
        totalInstructors,
        totalLearners,
        bannedUsers,
      },
      topInstructors,
      recentMarketCourses,
    });
  } catch (error) {
    console.error("adminController.getDashboardStats:", error);
    return res.error(error.message, 500);
  }
};

// ============================================================
// 2. QUẢN LÝ TÀI KHOẢN - USER MANAGEMENT
// ============================================================

/** Lấy danh sách tất cả users (có filter, search, pagination) */
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 15, search = "", role = "", banned = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { role: { $ne: "admin" } };

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (role) {
      query.role = role;
    }
    if (banned === "true") {
      query.isBanned = true;
    } else if (banned === "false") {
      query.isBanned = false;
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select("-password -refreshToken")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(query),
    ]);

    return res.success({
      users,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Lấy chi tiết 1 user + số khoá học của họ */
const getUserDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select("-password -refreshToken");
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user." });

    const [courseCount, publicCourseCount] = await Promise.all([
      Plan.countDocuments({ owner: id, isDeleted: false }),
      Plan.countDocuments({ owner: id, isPublic: true, isDeleted: false }),
    ]);

    const recentCourses = await Plan.find({ owner: id, isDeleted: false })
      .select("title topic isPublic createdAt sourceType")
      .sort({ createdAt: -1 })
      .limit(5);

    return res.success({ user, courseCount, publicCourseCount, recentCourses });
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Thay đổi role của user (thêm/bỏ instructor) */
const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body; // role: "instructor" hoặc "learner"

    if (!["instructor", "learner"].includes(role)) {
      return res.status(400).json({ success: false, message: "Role không hợp lệ." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user." });
    if (user.role.includes("admin")) {
      return res.status(403).json({ success: false, message: "Không thể sửa tài khoản admin." });
    }

    if (role === "instructor") {
      if (!user.role.includes("instructor")) user.role.push("instructor");
    } else {
      // Gỡ bỏ instructor, giữ learner
      user.role = user.role.filter((r) => r !== "instructor");
      if (!user.role.includes("learner")) user.role.push("learner");
    }

    await user.save();
    return res.success(
      { id: user._id, role: user.role },
      `Đã cập nhật quyền thành: ${user.role.join(", ")}`
    );
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Ban tài khoản (chặn đăng nhập) */
const banUser = async (req, res) => {
  try {
    const { id } = req.params;// Lấy ID tài khoản cần khóa truyền từ URL
    const user = await User.findById(id);// Tìm user trong database bằng ID

    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user." });
    if (user.role.includes("admin")) {
      return res.status(403).json({ success: false, message: "Không thể ban tài khoản admin." });
    }

    user.isBanned = true;
    user.refreshToken = null; // Vô hiệu refresh token ngay lập tức
    await user.save();

    return res.success(null, `Đã khóa tài khoản: ${user.email}`);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Unban tài khoản */
const unbanUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findByIdAndUpdate(id, { isBanned: false }, { new: true }).select(
      "-password -refreshToken"
    );
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user." });

    return res.success(null, `Đã mở khóa tài khoản: ${user.email}`);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Xoá tài khoản (soft delete bằng cách ban vĩnh viễn & xoá data) */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user." });
    if (user.role.includes("admin")) {
      return res.status(403).json({ success: false, message: "Không thể xoá tài khoản admin." });
    }

    // Soft delete các khoá học của user
    await Plan.updateMany({ owner: id }, { isDeleted: true, deletedByOwner: true });

    // Xoá user
    await User.findByIdAndDelete(id);

    return res.success(null, `Đã xoá tài khoản: ${user.email}`);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Reset mật khẩu cho user */
const resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Mật khẩu phải có ít nhất 6 ký tự." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: "Không tìm thấy user." });

    user.password = newPassword; // pre-save hook sẽ tự hash
    await user.save();

    return res.success(null, `Đã reset mật khẩu cho: ${user.email}`);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// ============================================================
// 3. QUẢN LÝ KHOÁ HỌC - COURSE MANAGEMENT
// ============================================================

/** Lấy danh sách tất cả khoá học (filter, search, pagination) */
const getAllCourses = async (req, res) => {
  try {
    const { page = 1, limit = 15, search = "", isPublic = "", sourceType = "" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { isDeleted: false };

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { topic: { $regex: search, $options: "i" } },
        { tags: { $in: [new RegExp(search, "i")] } },
      ];
    }
    if (isPublic !== "") {
      query.isPublic = isPublic === "true";
    }
    if (sourceType) {
      query.sourceType = sourceType;
    }

    const [courses, total] = await Promise.all([
      Plan.find(query)
        .select("title topic isPublic sourceType level categories tags owner createdAt")
        .populate("owner", "fullName email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Plan.countDocuments(query),
    ]);

    return res.success({
      courses,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Lấy chi tiết 1 khoá học */
const getCourseDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Plan.findById(id)
      .populate("owner", "fullName email role")
      .populate("instructorId", "fullName email");

    if (!course) return res.status(404).json({ success: false, message: "Không tìm thấy khoá học." });

    const lessonCount = await Lesson.countDocuments({ planId: id });

    return res.success({ course, lessonCount });
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Admin xoá khoá học vi phạm */
const deleteCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Plan.findByIdAndUpdate(
      id,
      { isDeleted: true, isPublic: false },
      { new: true }
    );
    if (!course) return res.status(404).json({ success: false, message: "Không tìm thấy khoá học." });

    return res.success(null, `Đã xoá khoá học: "${course.title}"`);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/** Toggle Featured cho khoá học Market (thêm/bỏ tag "featured") */
const toggleFeatured = async (req, res) => {
  try {
    const { id } = req.params;
    const course = await Plan.findById(id);
    if (!course) return res.status(404).json({ success: false, message: "Không tìm thấy khoá học." });

    const isFeatured = course.tags?.includes("featured");
    if (isFeatured) {
      course.tags = course.tags.filter((t) => t !== "featured");
    } else {
      course.tags = [...(course.tags || []), "featured"];
    }
    await course.save();

    return res.success(
      { isFeatured: !isFeatured },
      isFeatured ? "Đã bỏ nổi bật khoá học." : "Đã gắn nổi bật khoá học!"
    );
  } catch (error) {
    return res.error(error.message, 500);
  }
};

module.exports = {
  getDashboardStats,
  getAllUsers,
  getUserDetail,
  updateUserRole,
  banUser,
  unbanUser,
  deleteUser,
  resetUserPassword,
  getAllCourses,
  getCourseDetail,
  deleteCourse,
  toggleFeatured,
};
