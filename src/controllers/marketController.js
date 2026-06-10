const Plan = require("../models/Plan");
const Lesson = require("../models/Lesson");
const User = require("../models/User");
const Chunk = require("../models/Chunk");
const Enrollment = require("../models/Enrollment");
const Assignment = require("../models/Assignment");
const Progress = require("../models/Progress");

// 1. Xem khái quát tiêu đề các ngày
const getCoursePreview = async (req, res) => {
  try {
    const { id } = req.params;
    const lessons = await Lesson.find({ planId: id, isDeleted: false })
      .select("dayNumber title summary") // Chỉ lấy tiêu đề và tóm tắt, không lấy content/quiz
      .sort({ dayNumber: 1 });

    return res.success(lessons);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 2. Lấy lộ trình về kho cá nhân
const importCourse = async (req, res) => {
  try {
    const sourcePlanId = req.params.id;
    const userId = req.user.id;

    // Lấy plan gốc
    const sourcePlan = await Plan.findById(sourcePlanId);
    if (!sourcePlan) return res.error("Không tìm thấy lộ trình gốc", 404);

    // Xác định xem đây là import từ Market hay từ lộ trình được chia sẻ riêng
    const isFromMarket = sourcePlan.isPublic === true;

    // Tạo Plan mới bản sao cho User
    const newPlan = await Plan.create({
      title: sourcePlan.title,
      topic: sourcePlan.topic,
      owner: userId,
      instructorId: sourcePlan.instructorId || null,
      duration: sourcePlan.duration,
      level: sourcePlan.level,
      learningFocus: sourcePlan.learningFocus,
      learningDepth: sourcePlan.learningDepth,
      learningGoals: sourcePlan.learningGoals,
      categories: sourcePlan.categories,
      tags: sourcePlan.tags,
      normalizedTags: sourcePlan.normalizedTags,
      documentMetadata: sourcePlan.documentMetadata,
      documentId: sourcePlan.documentId,
      sourceType: isFromMarket ? 'imported' : 'shared_import', // Phân biệt nguồn gốc
      isPublic: false // Bản sao cá nhân nên để private
    });

    // Copy toàn bộ bài học sang Plan mới
    const sourceLessons = await Lesson.find({ planId: sourcePlanId, isDeleted: false });
    const newLessons = sourceLessons.map(l => {
      const lessonData = l.toObject();
      delete lessonData._id;
      delete lessonData.id;
      delete lessonData.createdAt;
      delete lessonData.updatedAt;
      return {
        ...lessonData,
        planId: newPlan._id,
        status: lessonData.dayNumber === 1 ? 'in-progress' : 'locked'
      };
    });

    if (newLessons.length > 0) {
      await Lesson.insertMany(newLessons);
    }

    // Nếu khóa học này được share cho cá nhân, xóa user khỏi danh sách sharedWith để ẩn khỏi mục "Lộ trình được chia sẻ"
    if (sourcePlan.sharedWith && sourcePlan.sharedWith.some(id => id.toString() === userId.toString())) {
      sourcePlan.sharedWith = sourcePlan.sharedWith.filter(id => id.toString() !== userId.toString());
      await sourcePlan.save();
    }

    return res.success({ _id: newPlan._id }, "Đã lấy lộ trình về kho cá nhân thành công!");
  } catch (error) {
    console.error("Error importing course:", error);
    return res.error(error.message, 500);
  }
};

const getMarketCourses = async (req, res) => {
  try {
    const { search, category, level, page = 1, limit = 12, instructorSearch } = req.query;

    // Chỉ lấy những khóa học đã được bật isPublic
    const query = { isPublic: true, isDeleted: false };

    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    if (category && category !== 'all') {
      // Vì categories là mảng nên dùng $in
      query.categories = { $in: [category] };
    }

    if (level && level !== 'all') {
      query.level = level;
    }

    // ── Lọc theo tên hoặc email giảng viên ──────────────────────────
    if (instructorSearch && instructorSearch.trim()) {
      const User = require("../models/User");
      const matchedInstructors = await User.find({
        $or: [
          { fullName: { $regex: instructorSearch.trim(), $options: "i" } },
          { email: { $regex: instructorSearch.trim(), $options: "i" } },
        ],
      }).select("_id");
      query.owner = { $in: matchedInstructors.map(u => u._id) };
    }

    const courses = await Plan.find(query)
      .populate("owner", "fullName email")
      .populate("instructorId", "fullName email")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Plan.countDocuments(query);

    return res.success({
      courses,
      totalPages: Math.ceil(total / limit),
      currentPage: Number(page)
    });
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * GET /api/market/instructor/:instructorId/courses
 * Lấy danh sách khóa học public của 1 giảng viên cụ thể
 */
const getCoursesByInstructor = async (req, res) => {
  try {
    const { instructorId } = req.params;
    const courses = await Plan.find({
      owner: instructorId,
      isPublic: true,
      isDeleted: false,
    })
      .populate("owner", "fullName email")
      .populate("instructorId", "fullName email")
      .sort({ createdAt: -1 })
      .lean();
    return res.success(courses);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * GET /api/market/my-listings
 * Instructor lấy danh sách khóa học CỦA MÌNH đã đưa lên market (isPublic: true)
 */
const getMyListings = async (req, res) => {
  try {
    const userId = req.user.id;
    const courses = await Plan.find({
      $or: [
        { owner: userId },
        { instructorId: userId }
      ],
      isPublic: true,
      isDeleted: false,
    })
      .sort({ updatedAt: -1 })
      .lean();

    // Đếm số người đã import mỗi khóa học (sourceType = 'imported', đang tham chiếu về plan này)
    const coursesWithStats = await Promise.all(
      courses.map(async (course) => {
        const importCount = await Plan.countDocuments({
          sourceType: 'imported',
          title: course.title,       // heuristic nhận dạng bản gốc
          isDeleted: false,
          owner: { $ne: userId },
        });
        return { ...course, importCount };
      })
    );

    return res.success(coursesWithStats);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * PATCH /api/market/courses/:id/unlist
 * Instructor gỡ khóa học khỏi market (set isPublic = false)
 */
const unlistCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const plan = await Plan.findOne({
      _id: id,
      $or: [
        { owner: userId },
        { instructorId: userId }
      ],
      isDeleted: false
    });
    if (!plan) return res.error("Không tìm thấy khóa học hoặc bạn không có quyền.", 404);
    if (!plan.isPublic) return res.error("Khóa học này chưa được đưa lên Market.", 400);

    plan.isPublic = false;
    await plan.save();

    // ⚠️ Nếu khóa học đã được đánh dấu xóa ở dashboard (deletedByOwner hoặc deletedByInstructor)
    // thì khi unlist khỏi Market, tiến hành dọn dẹp xóa cứng vì không còn được hiển thị ở đâu nữa.
    const shouldHardDelete = plan.deletedByOwner && (!plan.instructorId || plan.deletedByInstructor);
    if (shouldHardDelete) {
      console.log(`🗑️ Khóa học đã unlist và trước đó đã bị xóa ở dashboard. Tiến hành xóa cứng: ${id}`);
      await Promise.all([
        Lesson.deleteMany({ planId: id }),
        Chunk.deleteMany({ planId: id }),
        Enrollment.deleteMany({ planId: id }),
        Assignment.deleteMany({ planId: id }),
        Progress.deleteMany({ planId: id }),
      ]);
      await Plan.findByIdAndDelete(id);
    }

    return res.success(null, "Đã gỡ khóa học khỏi Market thành công.");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * GET /api/market/my-imports
 * Hoc vien lay danh sach khoa hoc da import tu Market ve kho ca nhan
 */
const getMyImports = async (req, res) => {
  try {
    const userId = req.user.id;
    const courses = await Plan.find({
      owner: userId,
      sourceType: 'imported',
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .lean();
    return res.success(courses);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * DELETE /api/market/my-imports/:id
 * Hoc vien xoa (soft-delete) mot ban khoa hoc da import khoi kho ca nhan
 */
const removeImport = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const plan = await Plan.findOne({
      _id: id,
      owner: userId,
      sourceType: 'imported',
      isDeleted: false,
    });
    if (!plan) return res.error('Khong tim thay khoa hoc hoac ban khong co quyen.', 404);

    plan.isDeleted = true;
    await plan.save();

    return res.success(null, 'Da xoa khoa hoc khoi kho ca nhan.');
  } catch (error) {
    return res.error(error.message, 500);
  }
};

module.exports = {
  getMarketCourses,
  getCoursePreview,
  importCourse,
  getCoursesByInstructor,
  getMyListings,
  unlistCourse,
  getMyImports,
  removeImport
};