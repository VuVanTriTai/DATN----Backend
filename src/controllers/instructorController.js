const Enrollment = require("../models/Enrollment");
const Progress = require("../models/Progress");
const Plan = require("../models/Plan");
const Lesson = require("../models/Lesson");
const Assignment = require("../models/Assignment");

/**
 * 1. Lấy danh sách các lộ trình mà Giảng viên đang quản lý
 * Dùng cho trang: InstructorCourses.tsx
 */
const getMyCourses = async (req, res) => {
    try {
        const instructorId = req.user.id;

        // Tìm các lộ trình mà user này được gán làm instructor HOẶC user này là owner (tự tạo/clone)
        const courses = await Plan.find({ 
            $or: [
                { instructorId: instructorId, deletedByInstructor: { $ne: true } },
                { owner: instructorId, deletedByOwner: { $ne: true } }
            ],
            isDeleted: false
        }).populate("owner", "fullName email");

        // Đếm số lượng học viên thực tế cho mỗi khóa
        const coursesWithStats = await Promise.all(courses.map(async (course) => {
            const studentCount = await Enrollment.countDocuments({ 
                planId: course._id, 
                status: 'active' 
            });
            return {
                ...course.toObject(),
                studentCount
            };
        }));

        return res.success(coursesWithStats);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 2. Lấy số liệu thống kê chi tiết bên trong 1 Dashboard khóa học
 * Dùng cho trang: CourseDashboard.tsx (Tab Tổng quan & Học viên)
 */
// src/controllers/instructorController.js
const getCourseDashboardStats = async (req, res) => {
    try {
        const { planId } = req.params;
        const instructorId = req.user.id;

        // 1. Tìm Lộ trình và lấy thông tin Học viên (owner)
        // Cho phép truy cập nếu là giảng viên hướng dẫn HOẶC là chủ sở hữu (khóa clone)
        const plan = await Plan.findOne({ 
            _id: planId, 
            $or: [{ instructorId: instructorId }, { owner: instructorId }] 
        })
                               .populate("owner", "fullName email")
                               .populate("documentId", "fileUrl content");

        if (!plan) {
            return res.status(404).json({ 
                success: false, 
                message: "Không tìm thấy lộ trình hoặc bạn không có quyền quản lý lộ trình này." 
            });
        }

        // 2. Lấy danh sách toàn bộ bài học của lộ trình này để hiển thị ở Sidebar trái
        const lessons = await Lesson.find({ planId: planId, isDeleted: false })
                                    .sort({ dayNumber: 1 });

        // 3. Lấy danh sách tất cả học viên đang theo học lộ trình này (Enrollments)
        // Thường thì 1 lộ trình tự tạo chỉ có 1 học viên, nhưng cấu trúc này cho phép nhiều học viên
        const enrollments = await Enrollment.find({ planId, status: 'active' })
                                            .populate("learnerId", "fullName email");

        // 4. Tính toán tiến độ từng học viên và tiến độ trung bình cả khóa học
        const totalDays = plan.duration || 1;
        let totalProgressSum = 0;

        const studentsData = await Promise.all(enrollments.map(async (en) => {
            // Tìm bản ghi tiến độ của từng học viên cụ thể trong khóa học này
            const progress = await Progress.findOne({ userId: en.learnerId._id, planId });
            
            const completedCount = progress ? progress.completedDays.length : 0;
            const progressPercent = Math.min(100, Math.round((completedCount / totalDays) * 100));
            
            totalProgressSum += progressPercent;

            return { 
                id: en.learnerId._id, 
                name: en.learnerId.fullName, 
                email: en.learnerId.email,
                progress: progressPercent 
            };
        }));

        const avgProgress = enrollments.length > 0 
            ? Math.round(totalProgressSum / enrollments.length) 
            : 0;

        // 5. Trả về cấu trúc dữ liệu đầy đủ cho Frontend
        return res.success({
            planId: plan._id,
            planTitle: plan.title,
            ownerId: plan.owner?._id,
            studentName: plan.owner?.fullName || "Học viên chưa xác định",
            studentEmail: plan.owner?.email,
            studentCount: enrollments.length,
            avgProgress: avgProgress,
            lessons: lessons,       // Dữ liệu cho Sidebar trái
            document: plan.documentId, // Dữ liệu cho Tab tài liệu gốc
            students: studentsData  // Dữ liệu cho Tab danh sách học viên
        }, "Lấy dữ liệu Dashboard thành công");

    } catch (error) {
        console.error("🔥 Error in getCourseDashboardStats:", error);
        return res.error(error.message, 500);
    }
};
/**
 * 3. Lấy danh sách toàn bộ học viên đang hướng dẫn (không phân biệt khóa học)
 */
const getMyStudents = async (req, res) => {
    try {
        const students = await Enrollment.find({ instructorId: req.user.id })
            .populate("learnerId", "fullName email")
            .populate("planId", "title");
        return res.success(students);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 4. Lấy chi tiết tiến độ và bài tập của 1 học viên cụ thể trong 1 khóa học
 */
const getStudentDetail = async (req, res) => {
    try {
        const { planId, studentId } = req.params;
        
        // Lấy tiến độ
        const progress = await Progress.findOne({ userId: studentId, planId });
        
        // Lấy danh sách bài tập đã nộp trong khóa học này
        const assignments = await Assignment.find({ learnerId: studentId, planId })
            .populate("lessonId", "title dayNumber");

        return res.success({
            progress: progress ? progress.completedDays : [],
            assignments: assignments
        });
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 5. Lấy tiến độ chung của một học sinh
 */
const getStudentProgress = async (req, res) => {
    try {
        const { studentId } = req.params;
        const progress = await Progress.find({ userId: studentId }).populate("planId", "title");
        return res.success(progress);
    } catch (error) {
        return res.error(error.message, 500);
    }
};
// 1. Giáo viên cập nhật nội dung bài học (Ghi đè trực tiếp)
const updateStudentLesson = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const { content, summary, importantNotes, quiz, quizPool, videoUrl, assignmentUrl, solutionUrl } = req.body;

    // Xây dựng object update — chỉ cập nhật các trường được gửi lên
    const updateFields = { content, summary, importantNotes, videoUrl, assignmentUrl, solutionUrl };

    // Cập nhật quiz cũ nếu có
    if (Array.isArray(quiz)) updateFields.quiz = quiz;

    // ✅ FIX: Cập nhật quizPool (trường học sinh thực tế dùng) nếu được gửi lên
    if (Array.isArray(quizPool)) updateFields.quizPool = quizPool;

    const lesson = await Lesson.findByIdAndUpdate(
      lessonId,
      updateFields,
      { new: true }
    );

    return res.success(lesson, "Đã lưu thay đổi bài học.");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 1b. Giáo viên lưu thành bản khác (tạo một bản clone của toàn bộ khoá học với những thay đổi mới)
const saveLessonDraft = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const { content, summary, importantNotes, quiz, quizPool, videoUrl, assignmentUrl, solutionUrl, planId } = req.body;

    // 1. Tìm lesson đang sửa để biết nó thuộc plan nào
    const currentLesson = await Lesson.findById(lessonId);
    if (!currentLesson) return res.error("Không tìm thấy bài học", 404);

    const sourcePlanId = planId || currentLesson.planId;
    
    // 2. Lấy Plan gốc
    const sourcePlan = await Plan.findById(sourcePlanId);
    if (!sourcePlan) return res.error("Không tìm thấy lộ trình gốc", 404);

    // 3. Tạo Plan clone cho giáo viên
    const newPlan = await Plan.create({
      title: `${sourcePlan.title} (Bản sao của GV)`,
      owner: req.user.id,
      instructorId: null, // Không còn là khóa hướng dẫn nữa, đây là khóa của riêng GV
      documentId: sourcePlan.documentId,
      duration: sourcePlan.duration,
      learningGoals: sourcePlan.learningGoals,
      documentMetadata: sourcePlan.documentMetadata,
      sourceType: "self", // Đánh dấu là khóa tự biên soạn (enum hợp lệ: 'self')
      sharedWith: [],
      deletedByOwner: false,
      deletedByInstructor: false
    });

    // 4. Clone toàn bộ Lessons của Plan gốc
    const lessons = await Lesson.find({ planId: sourcePlanId, isDeleted: false });
    
    const newLessons = lessons.map(lesson => {
      // Nếu đây là bài học đang được chỉnh sửa thì áp dụng data mới
      if (lesson._id.toString() === lessonId.toString()) {
        return {
          planId: newPlan._id,
          dayNumber: lesson.dayNumber,
          title: lesson.title,
          content: content !== undefined ? content : lesson.content,
          summary: summary !== undefined ? summary : lesson.summary,
          importantNotes: importantNotes !== undefined ? importantNotes : lesson.importantNotes,
          quiz: Array.isArray(quiz) ? quiz : lesson.quiz,
          quizPool: Array.isArray(quizPool) ? quizPool : lesson.quizPool,
          videoUrl: videoUrl !== undefined ? videoUrl : lesson.videoUrl,
          assignmentUrl: assignmentUrl !== undefined ? assignmentUrl : lesson.assignmentUrl,
          solutionUrl: solutionUrl !== undefined ? solutionUrl : lesson.solutionUrl,
          status: lesson.status,
        };
      }

      // Còn không thì copy y nguyên
      const clonedLesson = lesson.toObject();
      delete clonedLesson._id;
      delete clonedLesson.createdAt;
      delete clonedLesson.updatedAt;
      delete clonedLesson.instructorDraft;
      delete clonedLesson.hasDraft;
      clonedLesson.planId = newPlan._id;
      return clonedLesson;
    });

    await Lesson.insertMany(newLessons);

    return res.success({ newPlanId: newPlan._id }, "Đã lưu thành bản sao mới trong kho của bạn!");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 2. Giáo viên xác nhận hoàn tất chỉnh sửa và gửi lại cho học viên
// Merge tất cả draft có trong các lesson vào nội dung chính, sau đó đánh dấu plan là 'reviewed'
const finalizeReview = async (req, res) => {
  try {
    const { planId } = req.params;

    // 1. Lấy tất cả lesson có draft đang chờ trong plan này
    const lessons = await Lesson.find({ planId, hasDraft: true, isDeleted: false });

    // 2. Với mỗi lesson có draft → merge draft vào field chính
    const mergeOps = lessons.map(async (lesson) => {
      const d = lesson.instructorDraft;
      if (!d) return;

      const mergeFields = {};
      if (d.content        != null) mergeFields.content        = d.content;
      if (d.summary        != null) mergeFields.summary        = d.summary;
      if (d.importantNotes != null) mergeFields.importantNotes = d.importantNotes;
      if (d.videoUrl       != null) mergeFields.videoUrl       = d.videoUrl;
      if (d.assignmentUrl  != null) mergeFields.assignmentUrl  = d.assignmentUrl;
      if (d.solutionUrl    != null) mergeFields.solutionUrl    = d.solutionUrl;
      if (d.quizPool != null && d.quizPool.length > 0) mergeFields.quizPool = d.quizPool;

      // Xóa draft sau khi merge
      mergeFields['instructorDraft'] = {};
      mergeFields['hasDraft'] = false;

      await Lesson.findByIdAndUpdate(lesson._id, mergeFields);
    });

    await Promise.all(mergeOps);

    // 3. Cập nhật trạng thái plan thành 'reviewed' và chuyển sourceType thành 'assigned' để hiển thị ở tab "Giáo viên gửi"
    await Plan.findByIdAndUpdate(planId, { status: 'reviewed', sourceType: 'assigned' });

    return res.success(null, "Đã gửi bản chỉnh sửa hoàn chỉnh cho học viên.");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

/**
 * 6. Giảng viên tạo khoá học thủ công (khung rỗng, không cần AI)
 * POST /api/instructor/manual-course
 * Body: { title, duration }
 */
const createManualCourse = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const { title, duration } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: "Tiêu đề khoá học không được để trống." });
    }
    const numDays = Math.max(1, Math.min(30, parseInt(duration, 10) || 7));

    // 1. Tạo Plan mới — owner là chính giảng viên, không có instructorId riêng
    const newPlan = await Plan.create({
      title: title.trim(),
      owner: instructorId,
      instructorId: null,
      duration: numDays,
      sourceType: "manual",
      status: "pending",
      isDeleted: false,
      deletedByOwner: false,
      deletedByInstructor: false,
    });

    // 2. Tạo N bài học rỗng
    const lessons = Array.from({ length: numDays }, (_, i) => ({
      planId: newPlan._id,
      dayNumber: i + 1,
      title: `Ngày ${i + 1}`,
      // content required:true trong Lesson model → dùng placeholder Markdown
      content: `## Ngày ${i + 1}\n\n*(Chưa có nội dung — hãy soạn thảo tại đây)*`,
      summary: '',
      importantNotes: [],
      quiz: [],
      quizPool: [],
      // Lesson status enum: 'locked' | 'in-progress' | 'completed'
      status: 'locked',
      isDeleted: false,
    }));

    await Lesson.insertMany(lessons);

    return res.status(201).json({
      success: true,
      message: `Đã tạo khoá học thủ công "${newPlan.title}" với ${numDays} bài học.`,
      data: { planId: newPlan._id },
    });
  } catch (error) {
    console.error("🔥 createManualCourse error:", error);
    return res.error(error.message, 500);
  }
};

module.exports = {
    getMyCourses,
    getCourseDashboardStats,
    getMyStudents,
    getStudentDetail,
    getStudentProgress,
    updateStudentLesson,
    saveLessonDraft,
    finalizeReview,
    createManualCourse,
};