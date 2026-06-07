"use strict";

const { splitIntoPropositions } = require("../utils/chunkText");

const mockParent = {
  section: "## 1.2 Stored Procedure",
  content: `## 1.2 Stored Procedure
Stored Procedure là một nhóm câu lệnh Transact-SQL được biên dịch sẵn. Nó giúp tăng hiệu năng hệ thống vì kế hoạch thực thi được lưu lại.
Ngoài ra, nó cũng cung cấp các tùy chọn bảo mật rất tốt.
Ví dụ cú pháp:
\`\`\`sql
CREATE PROC sp_GetEmployees
AS
BEGIN
    SELECT * FROM Employees;
END;
\`\`\`
Học viên cần lưu ý điều này khi cấu hình.`
};

console.log("Testing splitIntoPropositions:");
const propositions = splitIntoPropositions(mockParent);
console.log(JSON.stringify(propositions, null, 2));
console.log(`\nGenerated ${propositions.length} propositions.`);
