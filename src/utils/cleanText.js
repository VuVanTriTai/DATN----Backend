// utils/cleanText.js — DOCLING-AWARE CLEANER v5
"use strict";

/**
 * cleanText v5 — thay đổi so với v4:
 *
 *  FIX CHÍNH (từ bản phân tích slide PDF):
 *   1. fixOcrGluedWords — bổ sung thuật toán tổng quát tách từ dính
 *      KHÔNG phụ thuộc topic (SQL, toán, lịch sử, y học, ... đều dùng được)
 *      Strategy: maximal forward match trên trie từ điển tiếng Việt tần suất cao
 *      + CamelCase split + boundary detection chữ thường→HOA
 *
 *   2. stripSingleColumnTableWrap — bảng 1 cột từ slide PDF
 *      "| nội dung dài không phải bảng |" → unwrap thành plain text
 *      Giữ nguyên bảng thật (≥ 2 cột, hoặc có header separator ---)
 *
 *   3. lightPostProcess (extractText.js) — nay GỌI fixOcrGluedWords đầy đủ
 *      (trước đây bỏ sót bước này cho Docling output)
 *
 *   4. VI_COMMON_GLUED mở rộng thêm ~60 cặp domain-agnostic
 *
 *  GIỮ NGUYÊN từ v4:
 *   - options.preserveStructure
 *   - isHeadingOrViSentence guard trong flattenBrokenTables
 *   - numbered heading bảo toàn ở vertical defrag
 */

// ─────────────────────────────────────────────
// HTML ENTITY DECODER
// ─────────────────────────────────────────────
const HTML_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
  "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&#x27;": "'", "&#x2F;": "/", "&#47;": "/",
};

const decodeHtmlEntities = (str) => {
  let r = str.replace(/&[a-zA-Z]+;/g, (m) => HTML_ENTITIES[m] || m);
  r = r.replace(/&#(\d+);/g, (_, c) => {
    const n = parseInt(c, 10);
    return n < 32 && n !== 9 && n !== 10 && n !== 13 ? "" : String.fromCodePoint(n);
  });
  r = r.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    const n = parseInt(h, 16);
    return n < 32 && n !== 9 && n !== 10 && n !== 13 ? "" : String.fromCodePoint(n);
  });
  return r;
};

// ─────────────────────────────────────────────
// FIX 1: UNICODE SPACING REPAIR
// ─────────────────────────────────────────────
const fixUnicodeSpacing = (str) => {
  let result = str.replace(/ ([\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF])/g, "$1");
  result = result.replace(/([\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF]) /g, "$1");
  return result.normalize("NFC");
};

// ─────────────────────────────────────────────
// FIX 2: BROKEN URL REMOVAL
// ─────────────────────────────────────────────
const removeBrokenUrls = (str) => {
  let result = str.replace(/https?:\/\/\S+\s+\S*(?:\.\w+)?/g, (match) => {
    const body = match.replace(/^https?:\/\//, "");
    return /\s/.test(body) ? "" : match;
  });
  result = result.replace(/^https?:\/\/[^\s]+\s*$/gm, "");
  result = result.replace(/^[a-z]{1,5}\s+[\w/.\-]+\.\w{2,5}\s*$/gim, "");
  return result;
};

// ─────────────────────────────────────────────
// FIX 3: GARBAGE FRAGMENT REMOVAL
// ─────────────────────────────────────────────
const GARBAGE_PATTERNS = [
  /^\(\d+\)\)\s*[\d/]+/,
  /^-\s*['"`]\)\s*[\d\s\-]+$/,
  /^\)\s*\d+\s*$/,
  /^\(\s*\d+\s*\)\s*$/,
  /^\d{1,4}\s*$/,
  /^[\d\s,\-–—]+$/,
  /^[.\-_=*~`|]{3,}\s*$/,
  /^\d{1,2}[.)]\s*$/,
  /^[^\w\u00C0-\u024F\u1E00-\u1EFF]{1,3}$/,
];

const removeGarbageFragments = (str) =>
  str
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t === "") return true;
      return !GARBAGE_PATTERNS.some((pat) => pat.test(t));
    })
    .join("\n");

// ─────────────────────────────────────────────────────────────────
// ✅ MỚI v5: STRIP SINGLE-COLUMN TABLE WRAP
//
// Slide PDF thường bị wrap toàn bộ đoạn văn vào bảng 1 cột:
//   | nội dung rất dài ... |
//
// Bảng THẬT có ít nhất 1 trong các dấu hiệu:
//   a) Có dòng separator: |---|---| hoặc |:---|
//   b) Có ≥ 2 cell (≥ 2 dấu | nội tuyến) trên cùng dòng
//   c) Có ≥ 3 dòng liên tiếp bắt đầu bằng |
//      VÀ mỗi dòng có ≥ 2 cột
//
// Nếu KHÔNG phải bảng thật → bóc | ... | → plain text
// ─────────────────────────────────────────────────────────────────
const countCols = (line) => {
  // Đếm số cột: tách theo | và lọc cell không rỗng
  const stripped = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").filter((c) => c.trim().length > 0).length;
};

const isSeparatorRow = (line) =>
  /^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(line.trim());

const stripSingleColumnTableWrap = (text) => {
  const lines = text.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Không phải dòng bảng → giữ nguyên
    if (!trimmed.startsWith("|")) {
      result.push(line);
      i++;
      continue;
    }

    // Collect block liên tiếp bắt đầu bằng |
    const block = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      block.push(lines[i]);
      i++;
    }

    // Kiểm tra xem block này là bảng thật hay wrap giả
    const hasSeparator = block.some((l) => isSeparatorRow(l));
    const hasMultiCol = block.some((l) => countCols(l) >= 2);

    if (hasSeparator || hasMultiCol) {
      // Bảng thật — giữ nguyên
      result.push(...block);
    } else {
      // Bảng giả (1 cột từ slide) — unwrap thành plain text
      for (const bLine of block) {
        const unwrapped = bLine.trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .trim();
        if (unwrapped) result.push(unwrapped);
      }
    }
  }

  return result.join("\n");
};

// ─────────────────────────────────────────────
// FIX 4 (v4 PATCHED): BROKEN TABLE DETECTION & FLATTENING
// ─────────────────────────────────────────────
const SHORT_THRESHOLD = 60;
const MIN_RUN = 4;

const isSentenceLike = (t) =>
  t.endsWith(".") || t.endsWith(":") || t.endsWith("?") ||
  t.endsWith("!") || t.length > SHORT_THRESHOLD;

const isStructuralLine = (t) =>
  t === "" ||
  t.startsWith("|") ||
  t.startsWith(">") ||
  /^#{1,6}\s/.test(t) ||
  /^[-*+•◦]\s/.test(t) ||
  /^\d+\.\s/.test(t) ||
  t.startsWith("```");

const isHeadingOrViSentence = (t) => {
  if (/^\d+(\.\d+)+\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) return true;
  const viChars = (
    t.match(/[àáảãạăắằẳẵặâầấẩẫậèéẻẽẹêềếểễệđìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵÀÁẢÃẠĂẮẰẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆĐÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ]/g) || []
  ).length;
  if (t.length > 40 && viChars > 3) return true;
  return false;
};

const flattenBrokenTables = (str) => {
  const lines = str.split("\n");
  const result = [];
  let i = 0;
  let inCodeBlock = false;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith("```")) inCodeBlock = !inCodeBlock;
    if (inCodeBlock || isStructuralLine(t) || isSentenceLike(t) || isHeadingOrViSentence(t)) {
      result.push(line);
      i++;
      continue;
    }
    const run = [t];
    let j = i + 1;
    let tempInCodeBlock = inCodeBlock;
    while (j < lines.length) {
      const nLine = lines[j];
      const nt = nLine.trim();
      if (nt.startsWith("```")) tempInCodeBlock = !tempInCodeBlock;
      if (tempInCodeBlock || isStructuralLine(nt) || isSentenceLike(nt) || isHeadingOrViSentence(nt)) break;
      run.push(nt);
      j++;
    }
    if (run.length >= MIN_RUN) {
      result.push(run.filter(Boolean).join(" | "));
      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  return result.join("\n");
};

// ─────────────────────────────────────────────
// MARKDOWN ESCAPE CLEANUP
// ─────────────────────────────────────────────
const cleanMarkdownEscapes = (str) =>
  str
    .replace(/\\_/g, "_").replace(/\\\*/g, "*")
    .replace(/\\\[/g, "[").replace(/\\\]/g, "]")
    .replace(/\\#/g, "#").replace(/\\\|/g, "|");

// ─────────────────────────────────────────────────────────────────
// ✅ MỞ RỘNG v5: VI_COMMON_GLUED — domain-agnostic
//
// Bổ sung các cặp KHÔNG gắn với SQL/code:
//   - Học thuật, hành chính, y tế, kỹ thuật, kinh tế, luật, ...
// Nguyên tắc: chỉ thêm cặp rõ ràng, không gây false-positive
// ─────────────────────────────────────────────────────────────────
const VI_COMMON_GLUED = [
  // ── Từ gốc v4 ──
  [/giátrị/gi, "giá trị"],
  [/địnhnghĩa/gi, "định nghĩa"],
  [/thôngbáo/gi, "thông báo"],
  [/nhómcâu/gi, "nhóm câu"],
  [/thựchiện/gi, "thực hiện"],
  [/cơsởdữliệu/gi, "cơ sở dữ liệu"],
  [/đượcthực/gi, "được thực"],
  [/đượcđặt/gi, "được đặt"],
  [/lưutrữ/gi, "lưu trữ"],
  [/ứngdụng/gi, "ứng dụng"],
  [/bắtbuộc/gi, "bắt buộc"],
  [/tùychọn/gi, "tùy chọn"],
  [/tạothông/gi, "tạo thông"],
  [/ngườidùng/gi, "người dùng"],
  [/tạothành/gi, "tạo thành"],
  [/dữliệu/gi, "dữ liệu"],
  [/kiểmtra/gi, "kiểm tra"],
  [/xửlý/gi, "xử lý"],
  [/trảvề/gi, "trả về"],
  [/khaibáo/gi, "khai báo"],
  [/nộidung/gi, "nội dung"],
  [/chỉnhsửa/gi, "chỉnh sửa"],
  [/thamchiếu/gi, "tham chiếu"],
  [/thamsố/gi, "tham số"],
  [/câulệnh/gi, "câu lệnh"],
  [/hợplệ/gi, "hợp lệ"],
  [/tínhhợp/gi, "tính hợp"],
  [/cơsở/gi, "cơ sở"],
  [/điểmlưu/gi, "điểm lưu"],
  [/quảnlý/gi, "quản lý"],
  [/kếtquả/gi, "kết quả"],
  [/phươngpháp/gi, "phương pháp"],
  [/nguyêntắc/gi, "nguyên tắc"],
  [/khảnăng/gi, "khả năng"],
  [/thànhphần/gi, "thành phần"],
  [/điềukiện/gi, "điều kiện"],
  [/yêucầu/gi, "yêu cầu"],
  [/quátrình/gi, "quá trình"],
  [/kếhoạch/gi, "kế hoạch"],
  [/vấnđề/gi, "vấn đề"],
  [/giảipháp/gi, "giải pháp"],

  // ── v5 MỚI: Chung / học thuật ──
  [/khái niệm/gi, "khái niệm"],         // giữ nguyên nếu đã có khoảng trắng
  [/kháiniệm/gi, "khái niệm"],
  [/ví dụ/gi, "ví dụ"],
  [/vídụ/gi, "ví dụ"],
  [/chúý/gi, "chú ý"],
  [/lưuý/gi, "lưu ý"],
  [/tổngkết/gi, "tổng kết"],
  [/tổngquan/gi, "tổng quan"],
  [/phântích/gi, "phân tích"],
  [/đánhgiá/gi, "đánh giá"],
  [/sosánh/gi, "so sánh"],
  [/minhhoạ/gi, "minh hoạ"],
  [/minhọa/gi, "minh họa"],
  [/trìnhbày/gi, "trình bày"],
  [/mụctiêu/gi, "mục tiêu"],
  [/ứngdụng/gi, "ứng dụng"],
  [/bàitập/gi, "bài tập"],
  [/bàikiểm/gi, "bài kiểm"],
  [/bàigiảng/gi, "bài giảng"],
  [/bàihọc/gi, "bài học"],
  [/bàitoán/gi, "bài toán"],
  [/chươngtrình/gi, "chương trình"],
  [/họctập/gi, "học tập"],
  [/sinhviên/gi, "sinh viên"],
  [/giáoviên/gi, "giáo viên"],
  [/giảngviên/gi, "giảng viên"],
  [/nhậnxét/gi, "nhận xét"],
  [/kếtluận/gi, "kết luận"],
  [/thựctế/gi, "thực tế"],
  [/thựctiễn/gi, "thực tiễn"],

  // ── v5 MỚI: Kỹ thuật / công nghệ (không chỉ SQL) ──
  [/hệthống/gi, "hệ thống"],
  [/phầnmềm/gi, "phần mềm"],
  [/phầncứng/gi, "phần cứng"],
  [/mạnglưới/gi, "mạng lưới"],
  [/máychủ/gi, "máy chủ"],
  [/máykhách/gi, "máy khách"],
  [/máytính/gi, "máy tính"],
  [/giaothức/gi, "giao thức"],
  [/giaodịch/gi, "giao dịch"],
  [/giaotiếp/gi, "giao tiếp"],
  [/kếtnối/gi, "kết nối"],
  [/cổngkết/gi, "cổng kết"],
  [/truyềntải/gi, "truyền tải"],
  [/truyềnthông/gi, "truyền thông"],
  [/nhậndạng/gi, "nhận dạng"],
  [/xácthực/gi, "xác thực"],
  [/xácnhận/gi, "xác nhận"],
  [/bảomật/gi, "bảo mật"],
  [/bảotrì/gi, "bảo trì"],
  [/tốiưu/gi, "tối ưu"],
  [/hiệusuất/gi, "hiệu suất"],
  [/hiệunăng/gi, "hiệu năng"],
  [/tốcđộ/gi, "tốc độ"],
  [/đồngbộ/gi, "đồng bộ"],
  [/đồngthời/gi, "đồng thời"],
  [/cậpnhật/gi, "cập nhật"],
  [/tảivề/gi, "tải về"],
  [/ghilog/gi, "ghi log"],
  [/nhậtký/gi, "nhật ký"],

  // ── v5 MỚI: Kinh tế / tài chính / luật ──
  [/hợpđồng/gi, "hợp đồng"],
  [/thịtrường/gi, "thị trường"],
  [/doanhnghiệp/gi, "doanh nghiệp"],
  [/doanhthu/gi, "doanh thu"],
  [/chiphí/gi, "chi phí"],
  [/lợinhuận/gi, "lợi nhuận"],
  [/đầutư/gi, "đầu tư"],
  [/ngânsách/gi, "ngân sách"],
  [/thuếsuất/gi, "thuế suất"],
  [/báocáo/gi, "báo cáo"],
  [/tàikhoản/gi, "tài khoản"],
  [/tàisản/gi, "tài sản"],
  [/nghĩavụ/gi, "nghĩa vụ"],
  [/quyềnlợi/gi, "quyền lợi"],
  [/quyđịnh/gi, "quy định"],
  [/quytrình/gi, "quy trình"],
  [/điềukhoản/gi, "điều khoản"],
  [/pháplý/gi, "pháp lý"],
  [/pháplệnh/gi, "pháp lệnh"],

  // ── v5 MỚI: Y tế / khoa học ──
  [/nghiêncứu/gi, "nghiên cứu"],
  [/thínghiệm/gi, "thí nghiệm"],
  [/kếtquả/gi, "kết quả"],
  [/bệnhnhân/gi, "bệnh nhân"],
  [/chẩnđoán/gi, "chẩn đoán"],
  [/điềutrị/gi, "điều trị"],
  [/triệuchứng/gi, "triệu chứng"],
  [/phòngngừa/gi, "phòng ngừa"],
  [/sứckhỏe/gi, "sức khỏe"],
  [/môitrường/gi, "môi trường"],
  [/nănglượng/gi, "năng lượng"],
  [/nhiệtđộ/gi, "nhiệt độ"],

  // ── v5 MỚI: Cấu trúc câu / liên từ hay bị dính ──
  [/thôngqua/gi, "thông qua"],
  [/theođó/gi, "theo đó"],
  [/dođó/gi, "do đó"],
  [/vìvậy/gi, "vì vậy"],
  [/tuynhiên/gi, "tuy nhiên"],
  [/ngoàira/gi, "ngoài ra"],
  [/đặcbiệt/gi, "đặc biệt"],
  [/cụthể/gi, "cụ thể"],
  [/chẳnghạn/gi, "chẳng hạn"],
  [/vídụnhư/gi, "ví dụ như"],
  [/baogồm/gi, "bao gồm"],
  [/liênquan/gi, "liên quan"],
  [/liênkết/gi, "liên kết"],
  [/tươngứng/gi, "tương ứng"],
  [/tươngtự/gi, "tương tự"],
  [/hơnnữa/gi, "hơn nữa"],
  [/nóicách/gi, "nói cách"],
  [/theocách/gi, "theo cách"],
];

// ─────────────────────────────────────────────────────────────────
// ✅ MỚI v5: UNIVERSAL GLUED-WORD SPLITTER
//
// Vấn đề: PDF slide gộp nhiều từ thành chuỗi dính dài tuỳ ý:
//   "StoredProcedure", "Cúpháp", "Khaibáovàlàmviệcvớithamsố"
//
// Giải pháp: Trie-based maximal forward match
//   1. Xây trie từ danh sách từ tiếng Việt tần suất cao (~800 từ)
//   2. Với mỗi token không có khoảng trắng & dài ≥ 8 ký tự:
//      → thử tách maximal forward match
//      → nếu coverage ≥ 85% → dùng bản tách
//   3. Fallback: boundary detection (chữ thường→HOA, chữ→số)
//
// Domain-agnostic: không hardcode chủ đề, chỉ dùng từ vựng chung
// ─────────────────────────────────────────────────────────────────

// Danh sách từ tiếng Việt tần suất cao — domain-agnostic
// Bao gồm: từ đơn, từ ghép 2 âm tiết phổ biến
// Sắp xếp dài → ngắn để maximal match ưu tiên từ dài hơn
const VI_DICT_WORDS = [
  // Từ ghép dài (ưu tiên match trước)
  "thực hiện", "cơ sở dữ liệu", "phương pháp", "điều kiện", "kết quả",
  "quản lý", "ứng dụng", "hệ thống", "phần mềm", "truyền thông",
  "xác thực", "bảo mật", "giao dịch", "giao tiếp", "giao thức",
  "kết nối", "tối ưu", "hiệu suất", "hiệu năng", "đồng bộ",
  "cập nhật", "nghiên cứu", "thí nghiệm", "môi trường", "năng lượng",
  "doanh nghiệp", "hợp đồng", "thị trường", "ngân sách", "báo cáo",
  "quy trình", "quy định", "điều khoản", "pháp lý",
  "bài học", "bài toán", "chương trình", "sinh viên", "giảng viên",
  "kết luận", "tổng kết", "phân tích", "đánh giá", "so sánh",
  "lưu trữ", "tham số", "câu lệnh", "thông báo", "người dùng",
  "dữ liệu", "kiểm tra", "xử lý", "trả về", "khai báo",
  "nội dung", "chỉnh sửa", "tham chiếu", "điểm lưu", "giải pháp",
  // Từ đơn tiếng Việt thường xuyên bị dính
  "được", "không", "trong", "của", "với", "một", "các", "những", "này",
  "đó", "về", "từ", "đến", "và", "hay", "hoặc", "nhưng", "khi", "nếu",
  "là", "có", "cho", "theo", "qua", "tại", "vào", "ra", "trên", "dưới",
  "sau", "trước", "bằng", "giữa", "ngoài", "tại", "mỗi", "mọi", "cả",
  "như", "vì", "do", "nên", "thì", "mà", "để", "sẽ", "đã", "đang",
  "cần", "phải", "muốn", "thể", "được", "bị", "bởi", "giúp", "làm",
  "tạo", "gọi", "dùng", "sử", "dụng", "thực", "hiện", "chạy",
  "mới", "cũ", "lớn", "nhỏ", "cao", "thấp", "nhanh", "chậm",
  "tốt", "xấu", "đúng", "sai", "hợp", "lệ", "hợp lệ",
  "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười",
  "đầu", "cuối", "giữa", "trước", "sau", "trên", "dưới",
  "lần", "lượt", "loại", "dạng", "kiểu", "cách", "bước",
  "giá", "trị", "số", "lượng", "tổng", "phần", "nhóm", "mục",
  "tên", "tệp", "file", "thư", "mục", "đường", "dẫn",
  "người", "dùng", "hệ", "thống", "máy", "tính", "mạng",
  "phép", "toán", "hàm", "biến", "lệnh", "khối", "vòng", "lặp",
  "điều", "khiển", "luồng", "tiến", "trình", "luồng",
  "lỗi", "ngoại", "lệ", "cảnh", "báo", "thông", "báo",
].map((w) => w.replace(/\s+/g, "").toLowerCase()); // lưu dạng không dấu cách, lowercase

// Xây trie đơn giản (object lồng nhau) từ danh sách từ
// Key: từng ký tự (Unicode-safe), leaf: { $: true }
const buildTrie = (words) => {
  const trie = {};
  for (const w of words) {
    let node = trie;
    for (const ch of w) {
      if (!node[ch]) node[ch] = {};
      node = node[ch];
    }
    node.$ = true;
  }
  return trie;
};

// Trie của danh sách từ chuẩn (xây một lần khi load module)
const VI_TRIE = buildTrie(VI_DICT_WORDS);

/**
 * Maximal forward match — tách chuỗi thành mảng từ dùng trie
 * Trả về mảng tokens. Nếu không match được → giữ nguyên ký tự.
 */
const trieSegment = (str) => {
  const s = str.toLowerCase();
  const tokens = [];
  let i = 0;

  while (i < s.length) {
    let node = VI_TRIE;
    let lastMatch = -1;
    let j = i;

    while (j < s.length && node[s[j]]) {
      node = node[s[j]];
      j++;
      if (node.$) lastMatch = j;
    }

    if (lastMatch > i) {
      tokens.push(str.slice(i, lastMatch));
      i = lastMatch;
    } else {
      // Không match được → tiến 1 ký tự
      tokens.push(str[i]);
      i++;
    }
  }

  return tokens;
};

/**
 * Thử tách một token dính bằng trie.
 * Chỉ áp dụng nếu:
 *   - token dài ≥ 8 ký tự
 *   - coverage (ký tự thuộc từ được match) ≥ 80%
 *   - kết quả tách ra ≥ 2 từ có nghĩa (mỗi từ ≥ 2 ký tự)
 */
const tryTrieSplit = (token) => {
  if (token.length < 8) return token;
  // Không xử lý URL, số, code identifier
  if (/^[A-Z][A-Z0-9_]+$/.test(token)) return token; // ALL_CAPS constant
  if (/^\d/.test(token)) return token;
  if (/^https?:\/\//.test(token)) return token;

  const segments = trieSegment(token);

  // Tính coverage: bao nhiêu ký tự được match thành từ có nghĩa
  const matchedChars = segments
    .filter((s) => s.length >= 2)
    .reduce((sum, s) => sum + s.length, 0);
  const coverage = matchedChars / token.length;

  // Đủ coverage và tách thành ≥ 2 từ
  const meaningfulWords = segments.filter((s) => s.length >= 2);
  if (coverage >= 0.80 && meaningfulWords.length >= 2) {
    return segments.join(" ").replace(/\s{2,}/g, " ").trim();
  }

  return token;
};

// ─────────────────────────────────────────────
// CAMELCASE & BOUNDARY SPLIT (fallback)
// ─────────────────────────────────────────────

/**
 * Tách CamelCase và boundary chữ thường→HOA không cần từ điển.
 * Chỉ dùng cho token Latin (không có dấu tiếng Việt).
 * Ví dụ: "StoredProcedure" → "Stored Procedure"
 *         "SQLServer"       → "SQL Server"
 */
const splitCamelCase = (token) => {
  // Không tách nếu toàn uppercase (viết tắt: SQL, HTTP, NULL...)
  if (/^[A-Z0-9_]+$/.test(token) && token.length <= 10) return token;

  return token
    // Boundary: chữ thường → HOA: "storedProcedure" → "stored Procedure"
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Boundary: CHỮ HOA liên tiếp → HOA+thường: "SQLServer" → "SQL Server"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // Số xen giữa chữ: "version2Test" → "version 2 Test"
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2");
};

const VI_ACCENTED_CHARS =
  "àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệđìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ" +
  "ÀÁẢÃẠÂẦẤẨẪẬĂẰẮẲẴẶÈÉẺẼẸÊỀẾỂỄỆĐÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ";

const hasVietnamese = (s) => new RegExp(`[${VI_ACCENTED_CHARS}]`).test(s);

// ─────────────────────────────────────────────────────────────────
// ✅ TỔNG HỢP: fixOcrGluedWords v5
//
// Pipeline cho mỗi dòng:
//   1. Áp dụng VI_COMMON_GLUED (hardcoded pairs) — nhanh, chính xác
//   2. Với mỗi token dài ≥ 8 và không có khoảng trắng:
//      a. Nếu có dấu tiếng Việt → thử tryTrieSplit
//      b. Nếu chỉ Latin          → thử splitCamelCase
//   3. fixBrokenSplitTokens — sửa từ bị tách sai
//   4. Chuẩn hoá khoảng trắng
// ─────────────────────────────────────────────────────────────────

const fixBrokenSplitTokens = (line) => {
  const KNOWN_SPLIT_PAIRS = [
    [/\berr\s+or\b/gi, "error"],
    [/\boc\s*curr\s*ed\b/gi, "occurred"],
    [/\bconsist\s+ency\b/gi, "consistency"],
    [/\bprop\s+erty\b/gi, "property"],
    [/\bfunc\s+tion\b/gi, "function"],
    [/\bdefi\s*ni\s*tion\b/gi, "definition"],
    [/\bimple\s*men\s*ta\s*tion\b/gi, "implementation"],
    [/\bap\s*pli\s*ca\s*tion\b/gi, "application"],
    [/\bin\s*for\s*ma\s*tion\b/gi, "information"],
  ];
  let result = line;
  for (const [re, rep] of KNOWN_SPLIT_PAIRS) result = result.replace(re, rep);
  return result;
};

const fixOcrGluedWords = (text) => {
  if (!text || typeof text !== "string") return text || "";

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      // Không xử lý code fence, bảng markdown, comment
      if (
        trimmed.startsWith("```") ||
        trimmed.startsWith("|") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("--")
      ) {
        return line;
      }

      // 1. Hardcoded pairs (nhanh)
      let result = line;
      for (const [re, rep] of VI_COMMON_GLUED) result = result.replace(re, rep);

      // 2. Token-level split
      result = result
        .split(/\s+/)
        .map((token) => {
          if (token.length < 8) return token;
          if (hasVietnamese(token)) {
            // Thử trie segment cho tiếng Việt có dấu
            return tryTrieSplit(token);
          } else {
            // CamelCase / boundary split cho Latin
            return splitCamelCase(token);
          }
        })
        .join(" ");

      // 3. Bullet spacing
      result = result.replace(/◦([A-ZÀ-Ỹa-zà-ỹ])/g, "◦ $1");
      result = result.replace(/•([A-ZÀ-Ỹa-zà-ỹ])/g, "• $1");

      // 4. Fix over-split
      result = fixBrokenSplitTokens(result);

      return result.replace(/\s{2,}/g, " ").replace(/ \./g, ".").trimEnd();
    })
    .join("\n");
};

// ─────────────────────────────────────────────
// MAIN CLEANER (v5)
// ─────────────────────────────────────────────

/**
 * cleanText(text, options)
 *
 * options.preserveStructure = true
 *   Dùng cho Docling / mammoth — text đã có structure tốt.
 *   → Bỏ qua flattenBrokenTables và vertical defrag
 *   → Vẫn chạy stripSingleColumnTableWrap + fixOcrGluedWords
 *
 * options.preserveStructure = false (default)
 *   Dùng cho pdf-parse / OCR — text thô cần repair nhiều.
 *   → Full clean
 */
const cleanText = (text, options = {}) => {
  const preserveStructure = options.preserveStructure === true;

  if (!text || typeof text !== "string") return "";

  let result = text.normalize("NFC");
  result = decodeHtmlEntities(result);
  result = fixUnicodeSpacing(result);
  result = cleanMarkdownEscapes(result);
  result = removeBrokenUrls(result);

  // ✅ v5: Unwrap bảng 1 cột (slide PDF) — chạy TRƯỚC garbage removal
  // để các dòng sau khi unwrap có thể bị lọc đúng
  result = stripSingleColumnTableWrap(result);

  result = removeGarbageFragments(result);

  if (!preserveStructure) {
    result = flattenBrokenTables(result);
  }

  // Per-line cleanup
  let inCodeBlock = false;
  result = result
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("```")) { inCodeBlock = !inCodeBlock; return line; }
      if (inCodeBlock) return line;
      if (/^\s*\|/.test(line)) return line.trimEnd();
      if (/^#{1,6}\s/.test(line.trim())) return line;
      if (/^[\s]*[-*+]\s/.test(line)) return line;
      if (/^[\s]*\d+\.\s/.test(line)) return line;
      if (/^\d+(\.\d+)+\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(line.trim())) return line;
      return line.replace(/\s{3,}/g, "  ").replace(/\t/g, "  ").trimEnd();
    })
    .join("\n");

  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.replace(/^\d+\.\s*$/gm, "");
  result = result
    .replace(/\uFFFD/g, "").replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Vertical defrag (chỉ khi KHÔNG preserve structure)
  if (!preserveStructure) {
    const lines = result.split("\n");
    const defrag = [];
    let buf = [];
    let emptyCount = 0;
    let inCodeBlockDefrag = false;

    const flush = () => {
      if (buf.length > 0) {
        defrag.push(buf.join(" ").replace(/\s{2,}/g, " "));
        buf = [];
      }
    };

    const isMarkdownStructure = (line, inCB) => {
      if (inCB) return true;
      const t = line.trim();
      if (t === "") return true;
      if (t.startsWith("```")) return true;
      if (t.startsWith("|")) return true;
      if (t.startsWith(">")) return true;
      if (/^#{1,6}\s/.test(t)) return true;
      if (/^[-*+•◦]\s/.test(t)) return true;
      if (/^\d+\.\s/.test(t)) return true;
      if (/^\d+(\.\d+)+\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(t)) return true;
      return false;
    };

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("```")) inCodeBlockDefrag = !inCodeBlockDefrag;

      if (t === "") {
        emptyCount++;
        if (emptyCount >= 2 && buf.length > 0) { flush(); defrag.push(""); }
        else if (buf.length === 0) defrag.push("");
        continue;
      }
      emptyCount = 0;

      if (isMarkdownStructure(line, inCodeBlockDefrag) || t.length > 8) {
        flush();
        defrag.push(line);
      } else {
        buf.push(t);
      }
    }
    flush();
    result = defrag.join("\n");
  }

  result = result.replace(/\n{3,}/g, "\n\n").trim();

  // ✅ v5: fixOcrGluedWords chạy SAU tất cả các bước khác
  result = fixOcrGluedWords(result);

  return result;
};

module.exports = { cleanText, fixOcrGluedWords, stripSingleColumnTableWrap };