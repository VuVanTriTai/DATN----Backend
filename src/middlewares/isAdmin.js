/**
 * Middleware: Chỉ cho phép tài khoản có role "admin" đi tiếp.
 * Phải dùng SAU verifyToken.
 */
const isAdmin = (req, res, next) => {
  const userRoles = Array.isArray(req.user?.role) ? req.user.role : [req.user?.role];

  if (!userRoles.includes("admin")) {
    return res.status(403).json({
      success: false,
      message: "Bạn không có quyền Admin để thực hiện hành động này.",
    });
  }
  next();
};

module.exports = isAdmin;
