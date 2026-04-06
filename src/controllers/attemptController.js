// controllers/attemptController.js
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
      }
    );

    if (!attempts.data.length) {
      return res.error("Không tìm thấy attempt", 404);
    }

    return res.success(attempts);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

const getAttemptById = async (req, res) => {
  try {
    const attempt = await Attempt.findOne({
      _id: req.params.id,
      isDeleted: false,
    }).select("-isDeleted -deleteAt");

    if (!attempt) return res.error("Không tìm thấy attempt", 404);

    if (attempt.user.toString() !== req.user.id) {
      return res.error("Không có quyền", 403);
    }

    return res.success(attempt);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

module.exports = {
  getUserAttempts,
  getAttemptById,
};