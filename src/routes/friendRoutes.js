const express = require('express');
const router = express.Router();
const verifyToken = require('../middlewares/authMiddleware');
const {
  searchUsers,
  getMyFriends,
  getPendingRequests,
  sendRequest,
  acceptRequest,
  rejectRequest,
  unfriend,
  cancelRequest
} = require('../controllers/friendController');

router.use(verifyToken);

// Tìm kiếm user
router.get('/search', searchUsers);

// Danh sách bạn bè
router.get('/', getMyFriends);

// Lời mời đang chờ
router.get('/requests', getPendingRequests);

// Gửi lời mời kết bạn
router.post('/request/:userId', sendRequest);

// Chấp nhận / từ chối lời mời
router.put('/accept/:friendshipId', acceptRequest);
router.put('/reject/:friendshipId', rejectRequest);

// Hủy lời mời đã gửi
router.delete('/cancel/:userId', cancelRequest);

// Hủy kết bạn
router.delete('/:userId', unfriend);

module.exports = router;
