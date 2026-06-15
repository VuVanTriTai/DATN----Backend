const Friendship = require('../models/Friendship');
const User = require('../models/User');

// ── Tìm kiếm user theo email hoặc tên ─────────────────────────────────────
const searchUsers = async (req, res) => {
  try {
    const { q } = req.query;
    const meId = req.user.id;
    if (!q || q.trim().length < 2) return res.error('Từ khóa quá ngắn', 400);

    const users = await User.find({
      _id: { $ne: meId },
      $or: [
        { email: { $regex: q.trim(), $options: 'i' } },
        { fullName: { $regex: q.trim(), $options: 'i' } }
      ]
    }).select('_id fullName email role').limit(10);

    // Bổ sung trạng thái friendship cho mỗi user
    const enriched = await Promise.all(users.map(async (u) => {
      const friendship = await Friendship.findOne({
        $or: [
          { requester: meId, recipient: u._id },
          { requester: u._id, recipient: meId }
        ]
      });
      return {
        _id: u._id,
        fullName: u.fullName,
        email: u.email,
        role: u.role,
        friendshipStatus: friendship ? friendship.status : null,
        friendshipId: friendship ? friendship._id : null,
        iAmRequester: friendship ? friendship.requester.toString() === meId : false
      };
    }));

    return res.success(enriched);
  } catch (e) {
    return res.error(e.message, 500);
  }
};

// ── Lấy danh sách bạn bè đã kết nối ──────────────────────────────────────
const getMyFriends = async (req, res) => {
  try {
    const meId = req.user.id;
    const friendships = await Friendship.find({
      status: 'accepted',
      $or: [{ requester: meId }, { recipient: meId }]
    }).populate('requester', 'fullName email role')
      .populate('recipient', 'fullName email role')
      .sort({ updatedAt: -1 });

    const friends = friendships
      .filter(f => f.requester && f.recipient) // Phòng hờ người dùng bị xóa khỏi hệ thống
      .map(f => {
        const friend = f.requester._id.toString() === meId ? f.recipient : f.requester;
        return { friendshipId: f._id, friend, since: f.updatedAt };
      });

    return res.success(friends);
  } catch (e) {
    return res.error(e.message, 500);
  }
};

// ── Lấy lời mời kết bạn đang chờ (nhận được) ─────────────────────────────
const getPendingRequests = async (req, res) => {
  try {
    const meId = req.user.id;
    const requests = await Friendship.find({
      recipient: meId,
      status: 'pending'
    }).populate('requester', 'fullName email role')
      .sort({ createdAt: -1 });

    const validRequests = requests.filter(r => r.requester); // Phòng hờ requester bị xóa khỏi hệ thống
    return res.success(validRequests);
  } catch (e) {
    return res.error(e.message, 500);
  }
};


// ── Gửi lời mời kết bạn ──────────────────────────────────────────────────
const sendRequest = async (req, res) => {
  try {
    const meId = req.user.id;
    const { userId } = req.params;

    if (meId === userId) return res.error('Không thể kết bạn với chính mình', 400);

    const target = await User.findById(userId);
    if (!target) return res.error('Người dùng không tồn tại', 404);

    // Kiểm tra đã có friendship chưa
    const existing = await Friendship.findOne({
      $or: [
        { requester: meId, recipient: userId },
        { requester: userId, recipient: meId }
      ]
    });

    if (existing) {
      if (existing.status === 'accepted') return res.error('Đã là bạn bè', 400);
      if (existing.status === 'pending') return res.error('Đã gửi lời mời rồi', 400);
      // Nếu bị từ chối trước đó → cho phép gửi lại
      existing.status = 'pending';
      existing.requester = meId;
      existing.recipient = userId;
      await existing.save();
      return res.success(existing, 'Đã gửi lại lời mời kết bạn');
    }

    const friendship = await Friendship.create({ requester: meId, recipient: userId });
    return res.success(friendship, 'Đã gửi lời mời kết bạn!');
  } catch (e) {
    return res.error(e.message, 500);
  }
};

// ── Chấp nhận lời mời ────────────────────────────────────────────────────
const acceptRequest = async (req, res) => {
  try {
    const meId = req.user.id;
    const { friendshipId } = req.params;

    const f = await Friendship.findOne({ _id: friendshipId, recipient: meId, status: 'pending' });
    if (!f) return res.error('Không tìm thấy lời mời', 404);

    f.status = 'accepted';
    await f.save();
    return res.success(f, 'Đã chấp nhận kết bạn!');
  } catch (e) {
    return res.error(e.message, 500);
  }
};

// ── Từ chối lời mời ──────────────────────────────────────────────────────
const rejectRequest = async (req, res) => {
  try {
    const meId = req.user.id;
    const { friendshipId } = req.params;

    const f = await Friendship.findOne({ _id: friendshipId, recipient: meId, status: 'pending' });
    if (!f) return res.error('Không tìm thấy lời mời', 404);

    f.status = 'rejected';
    await f.save();
    return res.success(null, 'Đã từ chối lời mời');
  } catch (e) {
    return res.error(e.message, 500);
  }
};

// ── Hủy kết bạn ──────────────────────────────────────────────────────────
const unfriend = async (req, res) => {
  try {
    const meId = req.user.id;
    const { userId } = req.params;

    await Friendship.findOneAndDelete({
      status: 'accepted',
      $or: [
        { requester: meId, recipient: userId },
        { requester: userId, recipient: meId }
      ]
    });

    return res.success(null, 'Đã hủy kết bạn');
  } catch (e) {
    return res.error(e.message, 500);
  }
};

// ── Hủy lời mời đã gửi ───────────────────────────────────────────────────
const cancelRequest = async (req, res) => {
  try {
    const meId = req.user.id;
    const { userId } = req.params;

    await Friendship.findOneAndDelete({
      requester: meId,
      recipient: userId,
      status: 'pending'
    });

    return res.success(null, 'Đã hủy lời mời kết bạn');
  } catch (e) {
    return res.error(e.message, 500);
  }
};

module.exports = {
  searchUsers,
  getMyFriends,
  getPendingRequests,
  sendRequest,
  acceptRequest,
  rejectRequest,
  unfriend,
  cancelRequest
};
