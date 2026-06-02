const User = require("../models/User");
const InstructorRating = require("../models/InstructorRating");

// ═══════════════════════════════════════════════════════
//  DANH SÁCH LĨNH VỰC CỐ ĐỊNH (có thể mở rộng)
// ═══════════════════════════════════════════════════════
const TEACHING_FIELDS = [
  "Toán học",
  "Vật lý",
  "Hóa học",
  "Sinh học",
  "Lập trình",
  "Trí tuệ nhân tạo",
  "Khoa học máy tính",
  "Tiếng Anh",
  "Tiếng Nhật",
  "Tiếng Trung",
  "Kinh tế",
  "Kế toán",
  "Tài chính",
  "Marketing",
  "Thiết kế đồ họa",
  "Âm nhạc",
  "Lịch sử",
  "Địa lý",
  "Văn học",
  "Triết học",
];

/**
 * GET /api/instructor-directory/fields
 * Lấy danh sách lĩnh vực hệ thống hỗ trợ (public)
 */
const getTeachingFields = async (req, res) => {
  try {
    return res.success(TEACHING_FIELDS);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * PUT /api/instructor-directory/my-fields
 * Giáo viên cập nhật lĩnh vực giảng dạy + hồ sơ
 */
const updateMyFields = async (req, res) => {
  try {
    const { teachingFields, specialization, bio } = req.body;

    if (!Array.isArray(teachingFields) || teachingFields.length === 0) {
      return res.error("Vui lòng chọn ít nhất 1 lĩnh vực giảng dạy.", 400);
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          "instructorProfile.teachingFields": teachingFields,
          "instructorProfile.specialization": specialization || "",
          "instructorProfile.bio": bio || "",
        },
      },
      { new: true }
    ).select("-password -refreshToken");

    return res.success(user, "Cập nhật lĩnh vực giảng dạy thành công!");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * GET /api/instructor-directory
 * Học viên xem danh sách giáo viên, lọc theo lĩnh vực, sắp xếp
 */
const getInstructorDirectory = async (req, res) => {
  try {
    const { field, sort = "rating", search = "" } = req.query;

    const query = { role: "instructor" };

    // Lọc theo lĩnh vực
    if (field && field !== "all") {
      query["instructorProfile.teachingFields"] = field;
    }

    // Tìm kiếm theo tên
    if (search.trim()) {
      query.fullName = { $regex: search.trim(), $options: "i" };
    }

    let instructors = await User.find(query)
      .select("fullName email instructorProfile")
      .lean();

    // Sắp xếp
    if (sort === "rating") {
      instructors.sort(
        (a, b) =>
          (b.instructorProfile?.avgRating || 0) -
          (a.instructorProfile?.avgRating || 0)
      );
    } else if (sort === "ratingCount") {
      instructors.sort(
        (a, b) =>
          (b.instructorProfile?.ratingCount || 0) -
          (a.instructorProfile?.ratingCount || 0)
      );
    } else if (sort === "name") {
      instructors.sort((a, b) => a.fullName.localeCompare(b.fullName, "vi"));
    }

    return res.success(instructors);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * POST /api/instructor-directory/:instructorId/rate
 * Học viên đánh giá giáo viên (1-5 sao)
 */
const rateInstructor = async (req, res) => {
  try {
    const { instructorId } = req.params;
    const learnerId = req.user.id;
    const { stars, comment } = req.body;

    if (!stars || stars < 1 || stars > 5) {
      return res.error("Số sao phải từ 1 đến 5.", 400);
    }

    // Kiểm tra giáo viên tồn tại
    const instructor = await User.findOne({
      _id: instructorId,
      role: "instructor",
    });
    if (!instructor) return res.error("Không tìm thấy giáo viên.", 404);

    // Không tự đánh giá
    if (instructorId === learnerId) {
      return res.error("Bạn không thể tự đánh giá chính mình.", 400);
    }

    // Upsert đánh giá (mỗi học viên 1 lần mỗi giáo viên)
    await InstructorRating.findOneAndUpdate(
      { instructor: instructorId, learner: learnerId },
      { stars, comment: comment || "" },
      { upsert: true, new: true }
    );

    // Tính lại avgRating và ratingCount
    const ratings = await InstructorRating.find({ instructor: instructorId });
    const ratingCount = ratings.length;
    const avgRating =
      ratingCount > 0
        ? parseFloat(
            (ratings.reduce((s, r) => s + r.stars, 0) / ratingCount).toFixed(1)
          )
        : 0;

    await User.findByIdAndUpdate(instructorId, {
      $set: {
        "instructorProfile.avgRating": avgRating,
        "instructorProfile.ratingCount": ratingCount,
      },
    });

    return res.success({ avgRating, ratingCount }, "Đánh giá thành công!");
  } catch (error) {
    // Lỗi unique key (đã đánh giá rồi nhưng upsert fail)
    return res.error(error.message, 500);
  }
};

/**
 * GET /api/instructor-directory/:instructorId/my-rating
 * Lấy đánh giá của học viên hiện tại cho giáo viên
 */
const getMyRating = async (req, res) => {
  try {
    const { instructorId } = req.params;
    const learnerId = req.user.id;

    const rating = await InstructorRating.findOne({
      instructor: instructorId,
      learner: learnerId,
    });

    return res.success(rating || null);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * GET /api/instructor-directory/:instructorId/ratings
 * Lấy tất cả đánh giá của 1 giáo viên (kèm tên học viên)
 */
const getInstructorRatings = async (req, res) => {
  try {
    const { instructorId } = req.params;

    const ratings = await InstructorRating.find({ instructor: instructorId })
      .populate("learner", "fullName")
      .sort({ createdAt: -1 })
      .lean();

    return res.success(ratings);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * GET /api/instructor-directory/me
 * Giáo viên xem hồ sơ + lĩnh vực của chính mình
 */
const getMyInstructorProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "fullName email instructorProfile"
    );
    return res.success(user);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

module.exports = {
  getTeachingFields,
  updateMyFields,
  getInstructorDirectory,
  rateInstructor,
  getMyRating,
  getInstructorRatings,
  getMyInstructorProfile,
};
