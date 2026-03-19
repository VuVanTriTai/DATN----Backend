/**
 * Làm sạch văn bản thô theo tiêu chuẩn tài liệu RAG đề xuất
 */
const cleanText = (text) => {
    if (!text) return "";
    return text
        .replace(/(Trang chủ|Tìm kiếm|Đăng nhập|Liên hệ|Bản quyền|---)/gi, "") // Xóa menu/footer nhiễu
        .replace(/\n\s*\n/g, "\n\n") // Chuẩn hóa khoảng trắng
        .replace(/[^\S\r\n]+/g, " ") // Xóa khoảng trắng thừa trên 1 dòng
        .trim();
};

module.exports = { cleanText };