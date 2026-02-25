const Attempt = require("../models/Attempt");
const paginate = require("../utils/paginate");

const getUserAttempts = async (req, res) => {
  try {
    const attempts = await paginate(
      Attempt,
      { user: req.user.id, isDeleted: false },
      { 
        page: req.query.page, 
        limit: req.query.limit, 
        select: "-isDeleted -deleteAt",
      },
    );

    if (!attempts || attempts.data.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Attempt không tìm thấy" });
    }

    res.status(200).json(attempts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAttemptById = async (req, res) => {
  try {
    const attempt = await Attempt.find({_id: req.params.id, isDeleted: false}).select("-isDeleted -deleteAt");
    
    if (!attempt) {
      return res
        .status(404)
        .json({ success: false, message: "Attempt không tìm thấy" });
    }

    if (attempt.user.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ success: false, message: "Bạn không có quyền truy cập attempt này" });
    }
    
    res.status(200).json(attempt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getUserAttempts,
  getAttemptById,
};
