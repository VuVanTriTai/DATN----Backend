const Attempt = require("../models/Attempt");

const getUserAttempts = async (req, res) => {
  try {
    const attempts = await Attempt.find({ user: req.user.id, isDeleted: false });

    if (!attempts || attempts.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Attempt không tìm thấy" });
    }

    res.status(200).json(attempts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAttemptByQuizId = async (req, res) => {
  try {
    const attempts = await Attempt.find({
      quiz: req.params.id,
      user: req.user.id,
      attemptNumber: req.params.number || 1,
      isDeleted: false,
    }).sort({ attemptNumber: 1 });
    
    if (!attempts || attempts.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Attempt không tìm thấy" });
    }

    res.status(200).json(attempts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getUserAttempts,
  getAttemptByQuizId,
};
