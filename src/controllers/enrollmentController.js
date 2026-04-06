const Enrollment = require("../models/Enrollment");

const getMyStudents = async (req, res) => {
    try {
        // Instructor lấy danh sách học viên đã chọn mình
        const students = await Enrollment.find({ instructorId: req.user.id })
            .populate("learnerId", "fullName email")
            .populate("planId", "title duration");
        
        return res.success(students);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

const acceptStudent = async (req, res) => {
    const { enrollmentId } = req.params;
    await Enrollment.findByIdAndUpdate(enrollmentId, { status: "active" });
    return res.success(null, "Đã chấp nhận hướng dẫn học viên.");
};

module.exports = { getMyStudents, acceptStudent };