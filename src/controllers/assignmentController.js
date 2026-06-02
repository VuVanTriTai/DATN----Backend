const Assignment = require("../models/Assignment");

/**
 * 1. Learner nộp bài tập
 */
const uploadAssignment = async (req, res) => {
    // Hàm này xử lý việc learner nộp bài tập. Nó nhận file upload (qua Multer),
    try {
        const { planId, lessonId } = req.body;
        // Lấy thông tin từ request body (có thể là form-data)
        if (!req.file) return res.error("Vui lòng đính kèm file bài làm.", 400);
// Tạo bản ghi Assignment mới với status "submitted"
        
        const assignment = await Assignment.create({
            learnerId: req.user.id,
            planId,
            lessonId,
            fileUrl: req.file.location || req.file.path, 
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

const aiGradeAssignment = async (req, res) => {
    try {
        const { id } = req.params;
        const assignment = await Assignment.findById(id).populate("lessonId", "title content solutionUrl");
        
        if (!assignment) return res.error("Không tìm thấy bài nộp.", 404);
        if (!assignment.lessonId) return res.error("Không tìm thấy thông tin bài học.", 404);
        
        const lesson = assignment.lessonId;
        
        // 1. Lấy nội dung đáp án của người hướng dẫn
        let instructorSolutionText = "";
        if (lesson.solutionUrl) {
            // Lấy text từ file đáp án (nếu là file Cloudinary)
            try {
                // Giả lập một object file để extractTextFromFile xử lý
                let mimeType = "application/pdf";
                if (lesson.solutionUrl.endsWith(".docx")) mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                else if (lesson.solutionUrl.endsWith(".txt")) mimeType = "text/plain";
                
                const extracted = await require("../utils/extractText").extractTextFromFile({
                    path: lesson.solutionUrl,
                    mimetype: mimeType,
                    originalname: "solution"
                });
                instructorSolutionText = extracted.text;
            } catch (err) {
                console.warn("Lỗi khi đọc file đáp án của instructor:", err.message);
                instructorSolutionText = "Không thể đọc file đáp án. Vui lòng dựa vào nội dung bài học để chấm.";
            }
        } else {
            instructorSolutionText = "Người hướng dẫn chưa cung cấp đáp án chuẩn. Vui lòng chấm dựa trên nội dung lý thuyết của bài học.";
        }

        // 2. Lấy nội dung bài làm của học viên
        let studentSubmissionText = assignment.learnerNote || "";
        if (assignment.fileUrl) {
            try {
                let mimeType = "application/pdf";
                if (assignment.fileUrl.endsWith(".docx")) mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
                else if (assignment.fileUrl.endsWith(".txt")) mimeType = "text/plain";

                const extracted = await require("../utils/extractText").extractTextFromFile({
                    path: assignment.fileUrl,
                    mimetype: mimeType,
                    originalname: "submission"
                });
                studentSubmissionText += "\n\n[Nội dung từ file đính kèm]:\n" + extracted.text;
            } catch (err) {
                console.warn("Lỗi khi đọc file bài làm của học viên:", err.message);
                studentSubmissionText += "\n\n(Lỗi: Hệ thống không thể đọc được nội dung file đính kèm này).";
            }
        }

        if (!studentSubmissionText.trim()) {
            return res.error("Bài nộp trống, không có nội dung để AI chấm.", 400);
        }

        // 3. Gọi AI chấm điểm
        const aiService = require("../services/aiService");
        const aiResponseString = await aiService.gradeAssignmentByAI(
            studentSubmissionText,
            instructorSolutionText,
            lesson.title + "\n" + lesson.content // Truyền thêm lý thuyết bài học để AI tham khảo
        );

        // 4. Parse kết quả JSON
        const aiResult = JSON.parse(aiResponseString);

        // 5. Cập nhật vào Database
        assignment.aiScore = aiResult.score;
        assignment.aiFeedback = aiResult.feedback;
        assignment.status = "ai_graded";
        await assignment.save();

        return res.success(assignment, "AI đã chấm điểm thành công.");
    } catch (error) {
        console.error("Lỗi AI chấm điểm:", error);
        return res.error(error.message, 500);
    }
};
const getMyAssignmentByLesson = async (req, res) => {
    try {
        const { lessonId } = req.params;
        const assignment = await Assignment.findOne({ 
            learnerId: req.user.id, 
            lessonId: lessonId 
        }).sort({ createdAt: -1 });
        
        return res.success(assignment || null);
    } catch (error) {
        return res.error(error.message, 500);
    }
};

module.exports = {
    uploadAssignment,
    getPendingAssignments,
    gradeAssignment,
    aiGradeAssignment,
    getMyAssignmentByLesson
};