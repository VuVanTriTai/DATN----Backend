"use strict";

const { cleanText } = require("../utils/cleanText");

const testCases = [
  "StoredProcedurelà một nhóm câu lệnh SQL.",
  "Để kiểmtraSQL, chúng ta dùng lệnh sau.",
  "Giải thích cơsởdữliệu và ứngdụngtrong thực tế.",
  "proceduretrong SQL Server hoạt động rất nhanh.",
  "Chúng ta cần CASTđể chuyển đổi kiểu dữ liệu.",
  "Trong databasecủa hệ thống có chứa bảng này.",
  "Hãy ALTERPROC để cập nhật thay đổi.",
  "Lỗi xảy ra trong quátrình xử lý dữliệuSQL.",
  "SQLkiểu mới giúp tối ưu hóa truy vấn."
];

console.log("=== Testing Backend cleanText ===");
for (const tc of testCases) {
  const cleaned = cleanText(tc);
  console.log(`Original: "${tc}"`);
  console.log(`Cleaned:  "${cleaned}"`);
  console.log("---");
}
