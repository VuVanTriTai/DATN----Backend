"use strict";

require("dotenv").config();
const { verifyLessonContent } = require("../services/planService");

const testHallucination = async () => {
  const context = `
  ## 2.3 Xem định nghĩa Stored Procedure
  Để xem mã nguồn định nghĩa của một Stored Procedure trong SQL Server, ta sử dụng thủ tục hệ thống sp_helptext.
  Cú pháp:
  EXEC sp_helptext 'tên_procedure';
  Ví dụ:
  EXEC sp_helptext 'sp_GetEmployees';
  `;

  const draftContent = `
  ## 2.3 Xem định nghĩa Stored Procedure

  Để xem mã nguồn định nghĩa của một Stored Procedure trong SQL Server, ta sử dụng thủ tục hệ thống \`sp_helptext\`.
  Cú pháp:
  \`\`\`sql
  EXEC sp_helptext 'tên_procedure';
  \`\`\`
  Ví dụ:
  \`\`\`sql
  EXEC sp_helptext 'sp_GetEmployees';
  \`\`\`

  ### Chỉnh sửa và Xóa Procedure
  Nếu bạn muốn thay đổi định nghĩa của thủ tục, bạn sử dụng lệnh \`ALTER PROCEDURE\`:
  \`\`\`sql
  ALTER PROCEDURE sp_GetEmployees
  AS
  BEGIN
      SELECT EmployeeID, FirstName, LastName FROM Employees;
  END;
  \`\`\`
  Để xóa thủ tục, sử dụng \`DROP PROCEDURE\`:
  \`\`\`sql
  DROP PROCEDURE sp_GetEmployees;
  \`\`\`
  `;

  console.log("\n=========================================");
  console.log("TEST CASE 1: Chống Hallucination (Bịa đặt ALTER/DROP)");
  console.log("=========================================");

  const result = await verifyLessonContent(draftContent, context);
  console.log("Verifier Result (Case 1):");
  console.log(JSON.stringify(result, null, 2));
};

const testCoverage = async () => {
  const context = `
  ## 3.1 Vòng lặp trong Python
  Python cung cấp hai kiểu vòng lặp chính là vòng lặp for và vòng lặp while.
  
  ### Lệnh điều khiển break
  Lệnh break dùng để kết thúc vòng lặp ngay lập tức khi gặp một điều kiện nhất định.
  Ví dụ:
  for i in range(10):
      if i == 5:
          break
      print(i)
      
  ### Lệnh điều khiển continue
  Lệnh continue dùng để bỏ qua các câu lệnh còn lại trong vòng lặp hiện tại và chuyển ngay sang lần lặp kế tiếp.
  Ví dụ:
  for i in range(5):
      if i == 2:
          continue
      print(i)
  `;

  const draftContent = `
  ## 3.1 Vòng lặp trong Python
  Python cung cấp hai kiểu vòng lặp chính là vòng lặp for và vòng lặp while.
  
  Vòng lặp for giúp duyệt qua các phần tử của một chuỗi (như list, tuple, string).
  Vòng lặp while thực thi khối lệnh chừng nào điều kiện còn đúng.
  `;

  console.log("\n=========================================");
  console.log("TEST CASE 2: Kiểm tra độ bao phủ (Bỏ sót break/continue)");
  console.log("=========================================");

  const result = await verifyLessonContent(draftContent, context);
  console.log("Verifier Result (Case 2):");
  console.log(JSON.stringify(result, null, 2));
};

const testMedicalNonTech = async () => {
  const context = `
  ## Chương II: Các giai đoạn của Sốt xuất huyết
  Bệnh sốt xuất huyết Dengue tiến triển qua 3 giai đoạn chính:
  
  1. Giai đoạn sốt: Sốt cao đột ngột, liên tục từ 2 đến 7 ngày. Nhức đầu, chán ăn, buồn nôn.
  2. Giai đoạn nguy hiểm: Thường vào ngày thứ 3 đến ngày thứ 7 của bệnh. Bệnh nhân có thể còn sốt hoặc đã giảm sốt. Có các biểu hiện thoát huyết tương, tràn dịch màng phổi, hạ tiểu cầu, xuất huyết dưới da hoặc chảy máu cam.
  3. Giai đoạn hồi phục: Sau giai đoạn nguy hiểm 24-48 giờ. Bệnh nhân hết sốt, toàn trạng tốt lên, thèm ăn, tiểu nhiều.
  
  Khuyến cáo: Chỉ dùng Paracetamol để hạ sốt. Tuyệt đối không dùng Aspirin hoặc Ibuprofen vì có thể gây chảy máu nặng hơn.
  `;

  const draftContent = `
  ## Các giai đoạn của Sốt xuất huyết Dengue
  
  Bệnh sốt xuất huyết Dengue tiến triển qua các giai đoạn sau:
  - Giai đoạn sốt: Bệnh nhân thường sốt cao đột ngột từ 2 đến 7 ngày, mệt mỏi, nhức đầu.
  
  Để điều trị triệu chứng hạ sốt, có thể sử dụng các thuốc kháng viêm và hạ sốt thông dụng như Paracetamol, Aspirin hoặc Ibuprofen để giúp người bệnh nhanh chóng hạ nhiệt.
  `;

  console.log("\n=========================================");
  console.log("TEST CASE 3: Chủ đề Y khoa (Medical - Đa dạng chủ đề)");
  console.log("=========================================");

  const result = await verifyLessonContent(draftContent, context);
  console.log("Verifier Result (Case 3):");
  console.log(JSON.stringify(result, null, 2));
};

const testLLMPostProcessing = async () => {
  const planServiceModule = require("../services/planService");
  
  // Bản tin thô bị dính chữ (glued words), lỗi font và chứa thuật ngữ sinh học phân tử (DNA, Polymerase, Nucleotide...)
  const rawChunkText = `
  tìnhbáocáo: côngnghệ sinhhọcphântử dna là nềntảng.
  Trongquátrìnhnhânđôi, enzyme dnaPolymerase sẽ kếthợpcác nucleotide tựdo vào mạchđơnđangtổnghợp.
  Điềunày giúp bảotoàn thôngtin ditruyềncủa tếbào.
  `;

  console.log("\n=========================================");
  console.log("TEST CASE 4: LLM Post-processing (Làm sạch & Chuẩn hóa thuật ngữ đa lĩnh vực)");
  console.log("=========================================");
  console.log("Input thô (dính chữ + lỗi font):", rawChunkText.trim());

  let needsLLM = false;
  if (typeof planServiceModule.checkTextQualityNeedsLLM === "function") {
    needsLLM = planServiceModule.checkTextQualityNeedsLLM(rawChunkText);
    console.log("-> checkTextQualityNeedsLLM check:", needsLLM ? "CẦN LÀM SẠCH (ĐÚNG)" : "BỎ QUA (SAI)");
  }

  let cleaned = rawChunkText;
  if (typeof planServiceModule.postProcessChunkWithLLM === "function") {
    cleaned = await planServiceModule.postProcessChunkWithLLM(rawChunkText);
  }
  
  console.log("-----------------------------------------");
  console.log("Output sau khi qua LLM Post-processing:");
  console.log(cleaned);
};

const testSelectivePostProcessing = async () => {
  const planServiceModule = require("../services/planService");
  
  // Bản tin sạch sẽ, không lỗi font, không dính chữ
  const cleanChunkText = `
  Học thuyết tế bào là một trong những học thuyết sinh học cơ bản nhất.
  Nó khẳng định rằng tất cả các sinh vật sống đều được cấu tạo từ một hoặc nhiều tế bào.
  Các tế bào mới được tạo ra từ các tế bào đã tồn tại trước đó thông qua quá trình phân chia.
  `;

  console.log("\n=========================================");
  console.log("TEST CASE 5: Selective Post-processing Bypass (Tiết kiệm Token)");
  console.log("=========================================");
  console.log("Input sạch:", cleanChunkText.trim());

  let needsLLM = true;
  if (typeof planServiceModule.checkTextQualityNeedsLLM === "function") {
    needsLLM = planServiceModule.checkTextQualityNeedsLLM(cleanChunkText);
    console.log("-> checkTextQualityNeedsLLM check:", needsLLM ? "CẦN LÀM SẠCH (SAI)" : "BỎ QUA & GIỮ NGUYÊN (ĐÚNG - TIẾT KIỆM TOKEN)");
  }

  const start = Date.now();
  let cleaned = cleanChunkText;
  if (typeof planServiceModule.postProcessChunkWithLLM === "function") {
    cleaned = await planServiceModule.postProcessChunkWithLLM(cleanChunkText);
  }
  const duration = Date.now() - start;
  
  console.log("-----------------------------------------");
  console.log(`Bypass speed: ${duration}ms (0ms nếu bypass thành công)`);
  console.log("Output text có bị biến đổi không:", cleaned.trim() === cleanChunkText.trim() ? "GIỮ NGUYÊN (HOÀN HẢO)" : "BỊ THAY ĐỔI (LỖI)");
};

const run = async () => {
  await testHallucination();
  await testCoverage();
  await testMedicalNonTech();
  await testLLMPostProcessing();
  await testSelectivePostProcessing();
};

run();
