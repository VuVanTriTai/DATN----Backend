/**
 * Middleware kiểm tra vai trò người dùng
 * @param {Array} roles - Danh sách các vai trò được phép (VD: ['learner', 'instructor'])
 */
const checkRole = (roles) => {
    return (req, res, next) => {
        // req.user được tạo ra từ verifyToken middleware trước đó
        if (!req.user) {
            return res.status(401).json({ 
                success: false, 
                message: "Bạn cần đăng nhập để thực hiện hành động này." 
            });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ 
                success: false, 
                message: `Quyền truy cập bị từ chối. Trang này dành cho: ${roles.join(', ')}` 
            });
        }

        next();
    };
};

module.exports = { checkRole };