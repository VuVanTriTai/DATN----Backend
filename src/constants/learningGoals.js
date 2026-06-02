/**
 * Mục tiêu học khi tạo lộ trình từ tài liệu (lý thuyết/thực hành × cơ bản/chuyên sâu).
 */

const VALID_FOCUS = ["theory", "practice"];
// Định hướng chính của lộ trình: thiên về lý thuyết hay thực hành.
const VALID_DEPTH = ["basic", "deep"];
// Mức độ sâu của lộ trình: cơ bản hay chuyên sâu.

const normalizeLearningGoals = (raw) => {
  // Chuẩn hóa thông tin học tập từ input thô (ví dụ từ form hoặc API request).
  // Nếu input không hợp lệ hoặc thiếu, sẽ dùng giá trị mặc định.
  const focus = VALID_FOCUS.includes(raw?.focus) ? raw.focus : "theory";
  // Nếu input không hợp lệ hoặc thiếu, mặc định là "basic" để phù hợp với đa số tài liệu.
  const depth = VALID_DEPTH.includes(raw?.depth) ? raw.depth : "basic";
  return { focus, depth };
};


/** Số câu quiz tối thiểu / tối đa mỗi bài (AI + hậu xử lý). */
const getQuizBounds = (profile) => {
  // Quy tắc số lượng câu quiz dựa trên profile học tập:
  // - THIÊN VỀ THỰC HÀNH thường cần nhiều câu hơn để kiểm tra kỹ năng áp dụng.
  // - CHUYÊN SÂU cũng có thể yêu cầu nhiều câu hơn để bao quát kiến thức rộng và sâu.
  const { focus, depth } = profile;
  if (focus === "practice" && depth === "deep") return { min: 7, max: 10 };
  if (focus === "practice") return { min: 5, max: 8 };
  if (depth === "deep") return { min: 4, max: 6 };
  return { min: 3, max: 5 };
};

const getLessonMaxTokens = (bounds, profile = null) => {
  // Giới hạn tokens cho phần giải thích bài giảng 
  // (không tính quiz).
  let t = bounds.max > 6 ? 2000 : 1200;

  if (profile?.focus === "practice" && profile?.depth === "deep") t = Math.max(t, 2600);
  else if (profile?.focus === "practice") t = Math.max(t, 1800);
  return t;
};
// Khi retry phần giải thích bài giảng (nếu bị cắt ngắn), 
// //có thể tăng giới hạn tokens để AI có thêm "đất" để hoàn thiện ý tưởng, đặc biệt với profile thiên về thực hành và chuyên sâu.
const getCompactRetryMaxTokens = (bounds, profile = null) => {
  let t = bounds.max > 6 ? 1600 : 900;
  
  if (profile?.focus === "practice" && profile?.depth === "deep") t = Math.max(t, 2000);
  else if (profile?.focus === "practice") t = Math.max(t, 1200);
  return t;
};

/** Hướng dẫn thêm cho bước phân tích tài liệu (độ dài khóa, nhấn mạnh). */
const analyzeContextBlock = (profile) => {
  const { focus, depth } = profile;
  const focusLine =
    focus === "practice"
      ? "Người học muốn THIÊN VỀ THỰC HÀNH: ưu tiên bài tập, tình huống, kỹ năng áp dụng."
      : "Người học muốn THIÊN VỀ LÝ THUYẾT: ưu tiên khái niệm, định nghĩa, mô hình, chứng minh ý tưởng.";
  const depthLine =
    depth === "deep"
      ? "Mức CHUYÊN SÂU: có thể đề xuất lộ trình dài hơn (gần mức trần 14 ngày) nếu tài liệu dày; difficulty thường Medium/Hard."
      : "Mức CƠ BẢN: nắm kiến thức nền, không cần quá nhiều ngày; difficulty thường Easy/Medium.";
  return `${focusLine}\n${depthLine}`;
};

/** Bổ sung cho prompt syllabus. */
const syllabusBiasInstructions = (profile) => {
  const { focus, depth } = profile;
  let lines = [];
  if (focus === "practice") {
    lines.push(
      "- Mỗi ngày nên có góc THỰC HÀNH rõ (bài tập mẫu, case study, checklist thao tác) trong objective hoặc title gợi ý."
    );
    lines.push("- Tránh chỉ liệt kê định nghĩa khô; gắn mục tiêu với việc LÀM được việc gì.");
  } else {
    lines.push(
      "- Mỗi ngày ưu tiên nền tảng lý thuyết: khái niệm, mối quan hệ giữa ý tưởng, công thức/định lý nếu có trong tài liệu."
    );
    lines.push("- Objective mô tả HIỂU được gì, không nhất thiết phải là bài tập.");
  }
  if (depth === "deep") {
    lines.push("- Tiến trình sâu: phân lớp kiến thức, so sánh, hệ quả, ứng dụng nâng cao trong các ngày sau.");
  } else {
    lines.push("- Giữ phạm vi CƠ BẢN: mỗi ngày một chủ đề lõi, không lan sang chuyên đề phụ chưa có trong tài liệu.");
  }
  return lines.join("\n");
};

/** Phong cách bài giảng + quiz trong generateScientificLesson. */
const lessonStyleInstructions = (profile) => {
  const { focus, depth } = profile;
  const parts = [];
  if (focus === "practice") {
    parts.push(
      "THIÊN THỰC HÀNH: content nên có ví dụ tình huống, bước thực hiện, tiêu chí đánh giá kết quả; tránh chỉ lý thuyết suông."
    );
  } else {
    parts.push(
      "THIÊN LÝ THUYẾT: content tập trung định nghĩa, luận giải logic, sơ đồ khái niệm (markdown); ít kịch bản thao tác hơn."
    );
  }
  if (depth === "deep") {
    parts.push(
      "CHUYÊN SÂU: liên hệ giữa các phần trong CONTEXT, cạm bẫy thường gặp, phân biệt chi tiết tinh vi; giải thích đầy đủ hơn (khoảng 260-380 từ nếu cần)."
    );
  } else {
    parts.push("CƠ BẢN: ngôn ngữ dễ hiểu, một ý chính mỗi đoạn, content khoảng 220-300 từ.");
  }
  return parts.join(" ");
};

const quizInstructions = (profile, bounds) => {
  const { focus, depth } = profile;
  const { min, max } = bounds;
  let diff = "";
  if (focus === "practice" && depth === "deep") {
    diff =
      "Độ khó CAO: ưu tiên câu VẬN DỤNG (tình huống, quyết định thao tác, suy luận nhiều bước, so sánh kết quả). Tối thiểu 60% số câu phải là dạng áp dụng, KHÔNG hỏi lại nguyên văn tiêu đề chương.";
  } else if (focus === "practice") {
    diff =
      "Ưu tiên câu áp dụng: tình huống ngắn, chọn bước đúng/kết quả đúng; tối thiểu một nửa số câu không được chỉ là “nhắc định nghĩa”.";
  } else if (depth === "deep") {
    diff =
      "Độ khó khá: suy luận, so sánh, kết luận từ định nghĩa; tránh chỉ hỏi “là gì”.";
  } else {
    diff = "Độ khó nhẹ–trung bình: nắm khái niệm và ý chính trong bài.";
  }
  return `QUIZ: Tạo đúng ${min} đến ${max} câu trắc nghiệm 4 phương án. ${diff} Mỗi câu có explanation ngắn giải thích vì sao đáp án đúng dựa trên CONTEXT.`;
};

/**
 * Quy tắc chất lượng quiz — tránh template lặp và nhiễu “meta” vô nghĩa.
 */
const quizQualityRules = (profile) => {
  const { focus, depth } = profile;
  const appHeavy = focus === "practice";
  const deep = depth === "deep";

  const banList = `
CẤM TUYỆT ĐỐI trong TEXT của 4 phương án:
- Bất kỳ tiền tố/nhãn kiểu: "Đúng theo bài:", "Đúng theo tài liệu:", "Sai:", "Correct:", "Wrong:", "Đáp án đúng", "Phương án sai".
- Người làm bài chỉ đọc 4 khẳng định trung tính; đúng/sai được hệ thống chấm theo correctAnswer, KHÔNG được ghi trong chữ phương án.
CẤM phương án nhiễu meta vô nghĩa:
- "Nội dung này không xuất hiện trong tài liệu", "suy đoán ngoài ngữ cảnh", v.v.
Mọi phương án phải là phát biểu có nghĩa về CHỦ ĐỀ; phương án sai là kiến thức sai có thể tin được (nhầm khái niệm, sai công thức, sai thứ tự, kết luận trái CONTEXT).
`;

  const variety = `
Mỗi câu hỏi phải có stem KHÁC NHAU (không copy cùng một câu hỏi rồi đổi mỗi đáp án). Không được lặp mẫu: "Theo bài học về [tiêu đề], phương án nào..." cho toàn bộ quiz.
Đáp án đúng không được chỉ là nhắc lại nguyên văn (copy-paste) công thức hoặc đoạn đã trích sẵn trong câu hỏi; phải là một phát biểu kiểm tra hiểu biết (diễn giải, hệ quả, bước áp dụng, hoặc kết quả sau khi vận dụng).
`;

  const formulaApp = `
Nếu CONTEXT có công thức, quy tắc tính, hoặc mối quan hệ định lượng: bắt buộc có ít nhất 1–2 câu hỏi dạng BÀI TẬP NHỎ — đưa số/biến cụ thể (chỉ dùng giá trị có trong CONTEXT hoặc ví dụ số đơn giản suy được từ công thức trong CONTEXT), yêu cầu chọn KẾT QUẢ đúng hoặc bước áp dụng đúng. Không bịa công thức mới.
`;

  const practiceDeep = appHeavy && deep ? `
Chế độ THỰC HÀNH + CHUYÊN SÂU: ưu tiên (1) mini-case có bối cảnh, (2) chọn quy trình/kiếm tra lỗi, (3) câu hỏi “nếu… thì…” cần 2 bước suy luận. Tránh đáp án đúng chỉ là ghép tên mục lục vào câu.
` : "";

  return [banList, variety, formulaApp, practiceDeep].filter(Boolean).join("\n");
};

module.exports = {
  VALID_FOCUS,
  VALID_DEPTH,
  normalizeLearningGoals,
  getQuizBounds,
  getLessonMaxTokens,
  getCompactRetryMaxTokens,
  analyzeContextBlock,
  syllabusBiasInstructions,
  lessonStyleInstructions,
  quizInstructions,
  quizQualityRules
};
