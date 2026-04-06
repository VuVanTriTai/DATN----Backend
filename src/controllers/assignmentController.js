const Assignment = require("../models/Assignment");

/**
 * 1. Learner nộp bài tập
 */
const uploadAssignment = async (req, res) => {
    try {
        const { planId, lessonId } = req.body;
        if (!req.file) return res.error("Vui lòng đính kèm file bài làm.", 400);

        const assignment = await Assignment.create({
            learnerId: req.user.id,
            planId,
            lessonId,
            fileUrl: req.file.path, // Đường dẫn file từ Multer
            status: "submitted"
        });

        return res.success(assignment, "Đã nộp bài thành công.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 2. Instructor lấy danh sách bài tập đang chờ chấm (Hàm bị thiếu gây lỗi)
 */
const getPendingAssignments = async (req, res) => {
    try {
        // Lấy các bài nộp thuộc các lộ trình mà Instructor này quản lý
        // Hoặc đơn giản là lấy toàn bộ bài nộp có status là submitted
        const assignments = await Assignment.find({ status: "submitted" })
            .populate("learnerId", "fullName email")
            .populate("planId", "title")
            .sort({ createdAt: -1 });

        return res.success(assignments);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

/**
 * 3. Instructor chấm điểm
 */
const gradeAssignment = async (req, res) => {
    try {
        const { id } = req.params;
        const { score, feedback } = req.body;

        const assignment = await Assignment.findById(id);
        if (!assignment) return res.error("Không tìm thấy bài nộp.", 404);

        assignment.score = score;
        assignment.feedback = feedback;
        assignment.status = "graded";
        assignment.gradedAt = new Date();
        assignment.instructorId = req.user.id; // Lưu ID người chấm

        await assignment.save();
        return res.success(assignment, "Đã chấm điểm thành công.");
    } catch (error) {
        return res.error(error.message, 500);
    }
};

module.exports = {
    uploadAssignment,
    getPendingAssignments, // PHẢI EXPORT HÀM NÀY
    gradeAssignment
};