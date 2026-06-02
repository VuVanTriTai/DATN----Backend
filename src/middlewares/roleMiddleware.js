/**
 * Middleware kiểm tra vai trò người dùng
 * @param {Array} roles - Danh sách các vai trò được phép (VD: ['learner', 'instructor'])
 */
const checkRole = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ message: "Chưa đăng nhập" });

        // Đảm bảo req.user.role luôn là mảng để so sánh
        const userRoles = Array.isArray(req.user.role) ? req.user.role : [req.user.role];

        // Kiểm tra xem user có bất kỳ quyền nào nằm trong danh sách allowedRoles không
        const hasAccess = allowedRoles.some(role => userRoles.includes(role));

        if (!hasAccess) {
            console.log(`🚫 Từ chối truy cập: User có roles [${userRoles}] nhưng cần [${allowedRoles}]`);
            return res.status(403).json({ 
                success: false, 
                message: "Bạn không có quyền thực hiện hành động này." 
            });
        }
        next();
    };
};

module.exports = { checkRole };