// services/lessonQuizService.js
"use strict";

const Groq = require("groq-sdk");
const Lesson = require("../models/Lesson");
const Progress = require("../models/Progress");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const POOL_SIZE = 20;

const DIFFICULTY_DIST = {
  BEGINNER:     { easy: 0.6, medium: 0.3, hard: 0.1 },
  INTERMEDIATE: { easy: 0.2, medium: 0.5, hard: 0.3 },
  EXPERT:       { easy: 0.1, medium: 0.3, hard: 0.6 },
};

// ── Model chain — ưu tiên model nhẹ để tiết kiệm TPD ─────────────────────────
// 70b tiêu ~4000 tokens/batch → hết hạn mức 100k/ngày sau ~25 batch
// 8b tiêu ~1000 tokens/batch  → dùng được ~100 batch/ngày
const QUIZ_MODEL_CHAIN = [
  { model: "llama-3.1-8b-instant",    maxTokens: 1800 },
  { model: "llama3-8b-8192",          maxTokens: 1600 },
  { model: "mixtral-8x7b-32768",      maxTokens: 2000 },
  { model: "llama-3.3-70b-versatile", maxTokens: 2400 }, // chỉ dùng khi 3 model trên đều fail
];

// ── Retry ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phân loại lỗi rate limit
const _isTPD = (msg) => /tokens per day|tpd/i.test(msg);       // hết hạn mức ngày → không retry
const _isRPM = (msg) => /tokens per minute|rpm|requests per minute/i.test(msg); // hết hạn mức phút → retry sau
const _is429 = (msg, status) => /rate_limit_exceeded|429/i.test(msg) || status === 429;

const retryWithBackoff = async (fn, maxRetries = 3) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const msg = String(err?.error?.message || err?.message || "");
      const status = err?.status || err?.response?.status || 0;
      const isRateLimit = _is429(msg, status);
      if (!isRateLimit) throw err;
      if (_isTPD(msg)) throw err;                          // TPD → fail immediately, không retry
      if (attempt === maxRetries - 1) throw err;
      let wait = 3000 * Math.pow(2, attempt);
      const m = msg.match(/try again in ([\d.]+)s/i);
      if (m) wait = Math.min(parseFloat(m[1]) * 1000 + 1200, 30000); // cap 30s
      console.warn(`[lessonQuizService] Rate limit. Retry ${attempt + 1}/${maxRetries} in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
};

// ── Domain Detection ───────────────────────────────────────────────────────────
const DOMAIN_KEYWORDS = {
  math:        /\b(đạo hàm|tích phân|ma trận|hàm số|phương trình|bất phương trình|hình học|xác suất|thống kê|định lý|chứng minh|số học|đại số|hằng đẳng thức|giới hạn|chuỗi số|vector|tọa độ|tam giác|lượng giác)\b/i,
  physics:     /\b(lực|gia tốc|vận tốc|động lượng|năng lượng|điện trường|từ trường|quang học|nhiệt động lực|cơ học|sóng|dao động|điện tích|điện áp|công suất|entropy|vật lý|newton|einstein)\b/i,
  chemistry:   /\b(nguyên tử|phân tử|ion|axit|bazơ|oxi hóa|khử|phản ứng hóa học|liên kết|hóa hữu cơ|hóa vô cơ|bảng tuần hoàn|mol|dung dịch|nồng độ|đồng phân|este|anken|ankin)\b/i,
  cs:          /\b(thuật toán|độ phức tạp|cấu trúc dữ liệu|lập trình|hàm|vòng lặp|đệ quy|cơ sở dữ liệu|mạng|bộ nhớ|stack|queue|tree|graph|sort|search|api|http|sql|nosql|class|object)\b/i,
  biology:     /\b(tế bào|gen|adn|arn|protein|enzym|quang hợp|hô hấp|tiến hóa|sinh thái|di truyền|nhiễm sắc thể|vi khuẩn|virus|sinh học|cơ thể|mô|cơ quan|hệ thần kinh|miễn dịch)\b/i,
  medicine:    /\b(bệnh|triệu chứng|chẩn đoán|điều trị|thuốc|lâm sàng|giải phẫu|sinh lý|dược lý|phẫu thuật|y khoa|bệnh nhân|liều dùng|tác dụng phụ|kháng sinh|vaccine)\b/i,
  economics:   /\b(gdp|lạm phát|cung cầu|thị trường|giá cả|đầu tư|tín dụng|ngân hàng|tài chính|kinh tế|chi phí|doanh thu|lợi nhuận|thuế|thương mại|xuất nhập khẩu)\b/i,
  law:         /\b(pháp luật|điều luật|quy định|hiến pháp|tội phạm|hợp đồng|trách nhiệm pháp lý|xét xử|luật dân sự|luật hình sự|pháp nhân|nghĩa vụ|quyền lợi|tố tụng|phán quyết|chế tài)\b/i,
  history:     /\b(thế kỷ|triều đại|chiến tranh|cách mạng|lịch sử|đế quốc|thuộc địa|phong trào|sự kiện|nhân vật lịch sử|văn minh|thời kỳ|cuộc kháng chiến|độc lập|thống nhất)\b/i,
  psychology:  /\b(tâm lý|nhận thức|hành vi|cảm xúc|vô thức|phản xạ|động lực|nhân cách|trí nhớ|học tập|rối loạn|liệu pháp|stress|tâm thần|xã hội hóa|bản năng|ý thức)\b/i,
  engineering: /\b(kỹ thuật|thiết kế|vật liệu|kết cấu|tải trọng|ứng suất|biến dạng|mạch điện|động cơ|nhiệt độ|áp suất|lưu lượng|hệ thống|quy trình sản xuất|chế tạo|cơ khí)\b/i,
};

const _detectDomain = (lesson, plan) => {
  const text = `${lesson.title || ""} ${(lesson.content || "").substring(0, 800)} ${plan?.title || ""}`.toLowerCase();
  // Đếm số keyword match để chọn domain có điểm cao nhất
  let bestDomain = "general";
  let bestScore = 0;
  for (const [domain, regex] of Object.entries(DOMAIN_KEYWORDS)) {
    const matches = text.match(new RegExp(regex.source, "gi")) || [];
    if (matches.length > bestScore) {
      bestScore = matches.length;
      bestDomain = domain;
    }
  }
  return bestDomain;
};

// ── Smart Context Extraction ───────────────────────────────────────────────────
// Giảm context xuống 1400 ký tự — 8b model có context window nhỏ hơn 70b,
// và prompt đã có title + instruction nên context dài thêm ít giá trị.
const _extractSmartContext = (lesson, domain) => {
  const content = lesson.content || "";
  if (content.length <= 1400) return content;

  // Ưu tiên đoạn chứa công thức, ví dụ, định lý, bảng số
  const highValuePatterns = [
    /ví dụ[\s\S]{0,400}/gi,
    /bài toán[\s\S]{0,400}/gi,
    /định lý[\s\S]{0,300}/gi,
    /công thức[\s\S]{0,300}/gi,
    /\$[\s\S]{0,150}\$/g,
    /```[\s\S]{0,300}```/g,
  ];

  let priorityChunks = [];
  for (const pat of highValuePatterns) {
    const matches = content.match(pat) || [];
    priorityChunks.push(...matches.map((m) => m.trim()));
  }

  // Lấy phần đầu (intro) + phần cuối (summary) + priority chunks
  const head     = content.substring(0, 500);
  const tail     = content.substring(Math.max(0, content.length - 300));
  const priority = [...new Set(priorityChunks)].join("\n").substring(0, 600);

  return [head, priority, tail].filter(Boolean).join("\n---\n").substring(0, 1400);
};

// ── Domain-Specific Prompt Instruction ────────────────────────────────────────
const _getDomainInstruction = (domain, focus, depth) => {
  const styles = {
    math:        "Tạo BÀI TOÁN CỤ THỂ với số liệu thực. Mỗi câu phải yêu cầu tính toán hoặc chứng minh. Đáp án phải là kết quả số, bước giải, hoặc nhận dạng công thức đúng. TUYỆT ĐỐI không hỏi định nghĩa suông.",
    physics:     "Tạo tình huống vật lý cụ thể (vật ném, mạch điện, sóng...) với số liệu. Yêu cầu áp dụng công thức/định luật để tính kết quả hoặc chọn phân tích đúng. Đáp án phải kèm đơn vị đo.",
    chemistry:   "Tạo bài toán hóa học: cân bằng phương trình, tính mol/nồng độ/khối lượng, nhận dạng sản phẩm phản ứng. Đáp án là con số cụ thể hoặc công thức hóa học.",
    cs:          "Tạo câu hỏi phân tích code/thuật toán: output của đoạn code, độ phức tạp O(n), lỗi logic, chọn cấu trúc dữ liệu phù hợp cho bài toán cụ thể. Chèn code snippet ngắn vào câu hỏi khi cần.",
    biology:     "Tạo tình huống sinh học: cơ chế phân tử, phân tích kết quả thí nghiệm, liên kết cấu trúc–chức năng. Đáp án là tên cơ chế/quá trình sinh học chính xác.",
    medicine:    "Tạo tình huống lâm sàng: bệnh nhân X có triệu chứng Y, hỏi chẩn đoán/cơ chế/điều trị phù hợp. Đáp án là lựa chọn lâm sàng cụ thể, không chung chung.",
    economics:   "Tạo tình huống kinh tế: dữ liệu thị trường, chính sách thuế, tỷ giá... Yêu cầu phân tích tác động hoặc tính toán chỉ số kinh tế cụ thể.",
    law:         "Tạo tình huống pháp lý giả định cụ thể (hợp đồng tranh chấp, hành vi vi phạm...). Hỏi điều khoản áp dụng, hậu quả pháp lý, hoặc so sánh quy định. Đáp án là lựa chọn pháp lý có căn cứ.",
    history:     "Tạo câu hỏi phân tích sự kiện lịch sử: nguyên nhân–hậu quả, so sánh các giai đoạn, đánh giá tác động của nhân vật/chính sách. KHÔNG chỉ hỏi năm tháng hay tên sự kiện.",
    psychology:  "Tạo tình huống hành vi/tâm lý cụ thể (trường hợp lâm sàng, thí nghiệm...). Hỏi cơ chế tâm lý, chẩn đoán, hoặc giải thích hành vi theo lý thuyết học được.",
    engineering: "Tạo bài toán kỹ thuật có thông số cụ thể (tải trọng, vật liệu, điều kiện biên...). Yêu cầu tính toán hoặc chọn giải pháp thiết kế phù hợp. Đáp án kèm đơn vị.",
    // ── FALLBACK THÔNG MINH: yêu cầu model tự phân tích nội dung ──────────────
    general:     "Đọc kỹ nội dung bài học và xác định: (1) Các khái niệm/quy trình/nguyên lý cốt lõi. (2) Tạo tình huống giả định hoặc bài toán nhỏ đòi hỏi VẬN DỤNG từng khái niệm đó — KHÔNG chỉ nhắc lại định nghĩa. (3) Các đáp án sai phải là những lựa chọn hợp lý gây nhầm lẫn thực sự.",
  };

  let domainLine = styles[domain] || styles.general;

  // Điều chỉnh thêm theo focus/depth
  if (focus === "practice" && depth === "deep") {
    domainLine += " Độ khó cao: kết hợp nhiều khái niệm, yêu cầu phân tích đa bước.";
  } else if (focus === "practice") {
    domainLine += " Vận dụng trực tiếp 1 công thức/quy trình vào bài toán đơn giản.";
  } else if (depth === "deep") {
    domainLine += " Phân tích sâu: so sánh điều kiện áp dụng, tìm phát biểu sai trong nhóm phát biểu đúng.";
  } else {
    domainLine += " Kiểm tra hiểu: nhận dạng đặc điểm, phân biệt khái niệm gần nhau.";
  }

  return domainLine;
};

// ── Build Prompt (compact) ─────────────────────────────────────────────────────
const _buildPrompt = (title, context, count, easyCount, mediumCount, hardCount, domain, focus, depth) => {
  const domainInstruction = _getDomainInstruction(domain, focus, depth);

  return `Tạo ĐÚNG ${count} câu trắc nghiệm (JSON) cho bài: "${title}"
Domain: ${domain} | Focus: ${focus} | Depth: ${depth}

NỘI DUNG BÀI HỌC:
${context}
===

LUẬT CHẤT LƯỢNG (bắt buộc):
- ${domainInstruction}
- 4 đáp án (A/B/C/D): cụ thể, khác nhau, không trùng ý, không "Tất cả đúng/sai", không "Không thể xác định"
- Đáp án SAI phải hợp lý (gây nhầm lẫn thực sự nếu không nắm vững), KHÔNG phải ngẫu nhiên
- CẤM đáp án bắt đầu bằng "Đúng" hoặc "Sai"
- explanation: giải thích rõ tại sao đáp án đúng (≥15 từ)

PHÂN BỔ ĐỘ KHÓ (tổng = ${count}):
- easy: ${easyCount} câu — Nhận biết/Ghi nhớ
- medium: ${mediumCount} câu — Thông hiểu/Vận dụng  
- hard: ${hardCount} câu — Phân tích/Đánh giá

FORMAT JSON (chỉ trả JSON, không text thêm):
{"questions":[{"question":"...","options":["A...","B...","C...","D..."],"correctAnswer":0,"explanation":"...","difficulty":"easy","bloomLevel":"Nhận biết","questionType":"singleChoice"}]}`;
};

// ── Batch Generate — model chain (fast → smart) ───────────────────────────────
const _generateBatch = async (title, context, count, easyC, medC, hardC, domain, focus, depth) => {
  const prompt = _buildPrompt(title, context, count, easyC, medC, hardC, domain, focus, depth);
  const systemMsg = "You are a JSON-only quiz generator for academic/scientific content. Output ONLY valid JSON starting with '{'."; 

  let lastErr;
  for (const { model, maxTokens } of QUIZ_MODEL_CHAIN) {
    try {
      const completion = await retryWithBackoff(() =>
        groq.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemMsg },
            { role: "user",   content: prompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.4,
          max_tokens: maxTokens,
        })
      );
      const parsed = extractJSON(completion.choices[0].message.content);
      console.log(`[QuizBatch] OK model=${model} count=${count}`);
      return Array.isArray(parsed.questions) ? parsed.questions : [];
    } catch (err) {
      const msg = String(err?.error?.message || err?.message || "");
      lastErr = err;
      if (_isTPD(msg)) {
        console.warn(`[QuizBatch] ${model} hết TPD → thử model tiếp theo`);
        continue; // thử model kế tiếp trong chain
      }
      // Lỗi không phải TPD (timeout, parse...) → dừng chain
      console.warn(`[QuizBatch] ${model} lỗi (không phải TPD): ${msg.slice(0, 80)}`);
      throw err;
    }
  }

  console.error("[QuizBatch] Toàn bộ model chain đều hết TPD.");
  throw lastErr;
};

// ── Generate Quiz Pool ─────────────────────────────────────────────────────────
const generateQuizPool = async (lessonId) => {
  const lesson = await Lesson.findById(lessonId).populate("planId");
  if (!lesson) throw new Error("Không tìm thấy bài học");

  const plan = lesson.planId;
  const focus = plan?.learningFocus || plan?.learningGoals?.focus || "theory";
  const depth = plan?.learningDepth || plan?.learningGoals?.depth || "basic";
  const domain = _detectDomain(lesson, plan);
  const context = _extractSmartContext(lesson, domain);

  console.log(`[QuizPool] "${lesson.title}" | Domain: ${domain} | Focus: ${focus} | Depth: ${depth}`);

  // Xác định số câu & tỷ lệ theo mode
  // ✅ FIX: Giảm số câu/batch để tiết kiệm tokens — 8b model vẫn đủ chất lượng
  let totalTarget, easyR, medR, hardR;
  if (focus === "practice" && depth === "deep") {
    totalTarget = 12; easyR = 0.08; medR = 0.34; hardR = 0.58;
  } else if (focus === "practice") {
    totalTarget = 10; easyR = 0.20; medR = 0.50; hardR = 0.30;
  } else if (depth === "deep") {
    totalTarget = 8;  easyR = 0.12; medR = 0.38; hardR = 0.50;
  } else {
    totalTarget = 8;  easyR = 0.38; medR = 0.37; hardR = 0.25;
  }

  // ✅ FIX: Giảm BATCH từ 8 → 5 câu/lần gọi AI
  // 5 câu × ~300 tokens/câu ≈ 1500 tokens output → phù hợp 8b model (max_tokens=1800)
  const BATCH = 5;
  const batches = [];
  let remaining = totalTarget + 2; // +2 câu dự phòng (giảm từ +4)
  while (remaining > 0) {
    batches.push(Math.min(BATCH, remaining));
    remaining -= BATCH;
  }

  let allQuestions = [];
  for (let i = 0; i < batches.length; i++) {
    const bSize = batches[i];
    const eC = Math.round(bSize * easyR);
    const mC = Math.round(bSize * medR);
    const hC = bSize - eC - mC;

    try {
      if (i > 0) await sleep(1500); // tránh rate limit giữa batches
      const qs = await _generateBatch(lesson.title, context, bSize, eC, mC, hC, domain, focus, depth);
      console.log(`[QuizPool] Batch ${i + 1}/${batches.length}: ${qs.length} câu nhận được`);
      allQuestions.push(...qs);
    } catch (err) {
      console.error(`[QuizPool] Batch ${i + 1} thất bại:`, err.message);
    }
  }

  if (allQuestions.length === 0) {
    throw new Error("Không thể sinh câu hỏi — tất cả batch đều thất bại.");
  }

  // Lọc chất lượng
  let valid = allQuestions.filter(_validateQuizQuestion);
  if (valid.length < Math.ceil(totalTarget * 0.6)) {
    // Fallback: lọc cơ bản nếu strict filter loại quá nhiều
    valid = allQuestions.filter(
      (q) => q?.question && Array.isArray(q?.options) && q.options.length === 4 &&
             !isNaN(Number(q?.correctAnswer)) && Number(q.correctAnswer) >= 0 && Number(q.correctAnswer) <= 3
    );
  }

  // Đảm bảo questionType
  for (const q of valid) {
    if (!q.questionType) q.questionType = "singleChoice";
  }

  const final = valid.slice(0, totalTarget);

  if (final.length === 0) throw new Error("Tất cả câu hỏi bị lọc do lỗi cấu trúc.");

  await Lesson.findByIdAndUpdate(lessonId, { quizPool: final });
  console.log(`✅ Quiz pool: ${final.length} câu | Domain: ${domain} | Bài: "${lesson.title}"`);

  return final;
};

// ── Select Adaptive ────────────────────────────────────────────────────────────
const selectQuestionsAdaptive = async (lessonId, userLevel = "INTERMEDIATE", numQuestions = 10) => {
  const lesson = await Lesson.findById(lessonId).lean();
  if (!lesson) throw new Error("Không tìm thấy bài học");

  const pool = lesson.quizPool || [];
  if (pool.length === 0) return [];

  const dist = DIFFICULTY_DIST[userLevel] || DIFFICULTY_DIST.INTERMEDIATE;
  const easy   = pool.filter((q) => q.difficulty === "easy");
  const medium = pool.filter((q) => q.difficulty === "medium");
  const hard   = pool.filter((q) => q.difficulty === "hard");

  const picked = [
    ..._pickRandom(easy,   Math.round(numQuestions * dist.easy)),
    ..._pickRandom(medium, Math.round(numQuestions * dist.medium)),
    ..._pickRandom(hard,   Math.round(numQuestions * dist.hard)),
  ];

  if (picked.length < numQuestions) {
    const used = new Set(picked.map((q) => q.question));
    const rest = pool.filter((q) => !used.has(q.question));
    picked.push(..._shuffle(rest).slice(0, numQuestions - picked.length));
  }

  return _shuffle(picked).slice(0, numQuestions);
};

// ── Process Adaptive Result ────────────────────────────────────────────────────
const processAdaptiveResult = async (userId, planId, dayNumber, score, lessonId) => {
  await Progress.findOneAndUpdate(
    { userId, planId },
    { $pull: { lessonScores: { dayNumber: Number(dayNumber) } } },
    { upsert: true }
  );
  await Progress.findOneAndUpdate(
    { userId, planId },
    { $push: { lessonScores: { dayNumber: Number(dayNumber), score, passedAt: new Date() } } }
  );

  const nextDay = Number(dayNumber) + 1;
  const unlocked = await Lesson.findOneAndUpdate(
    { planId, dayNumber: nextDay, status: "locked" },
    { status: "in-progress" },
    { new: true }
  );

  console.log(`✅ Quiz done: day=${dayNumber} score=${score}% → ${unlocked ? `mở bài ${nextDay}` : "hết bài"}`);

  return {
    action: "completed",
    score,
    message: score >= 60
      ? `Hoàn thành! Bạn đạt ${score}%. Bài học tiếp theo đã được mở.`
      : `Bạn đạt ${score}%. Cố gắng hơn ở bài sau nhé!`,
    nextUnlocked: !!unlocked,
    nextDayNumber: unlocked ? nextDay : null,
  };
};

// ── Helpers ────────────────────────────────────────────────────────────────────
const _pickRandom = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length));
const _shuffle    = (arr) => [...arr].sort(() => Math.random() - 0.5);

const _validateQuizQuestion = (q) => {
  if (!q?.question || !Array.isArray(q.options) || q.options.length !== 4) return false;

  const corrAns = Number(q.correctAnswer);
  if (isNaN(corrAns) || corrAns < 0 || corrAns > 3) return false;

  const type = q.questionType || "singleChoice";
  if (type !== "singleChoice" && type !== "multipleStatements") return false;

  const qClean = q.question.trim().toLowerCase();
  if (qClean.length < 10) return false;
  if (/(placeholder|---|___+|\.\.\.)/i.test(qClean)) return false;

  const options = q.options.map((o) => String(o || "").trim());
  if (options.some((o) => o.length < 3)) return false;

  const uniqueOpts = new Set(options.map((o) => o.toLowerCase()));
  if (uniqueOpts.size !== 4) return false;

  // Kiểm tra explanation
  const expl = String(q.explanation || "").trim();
  if (expl.length < 10) return false;

  // Chặn verdict leak
  const verdictRegex = /^(đúng|sai|correct|incorrect|true|false)(?:\b|[\s,.:;]|$)/i;
  const hasleak = options.some((o) => {
    const lower = o.toLowerCase();
    if (verdictRegex.test(lower) && !/^(sai số|sai lệch|sai sót|sai phân)\b/.test(lower)) return true;
    return false;
  });
  if (hasleak) return false;

  // Chặn meta phrases rác
  const badTerms = [
    "tất cả đều đúng", "tất cả các đáp án trên", "tất cả đều sai",
    "không có đáp án nào đúng", "không thể xác định", "không biết",
    "cả a và b", "cả b và c", "cả 3 đáp án", "không liên quan",
    "không xuất hiện trong tài liệu", "tùy thuộc vào ngữ cảnh",
  ];
  const hasBad = options.some((o) => {
    const lower = o.toLowerCase();
    return badTerms.some((t) => lower.includes(t));
  });
  if (hasBad) return false;

  return true;
};

const extractJSON = (raw) => {
  if (!raw || typeof raw !== "string") throw new Error("Empty response");
  try { return JSON.parse(raw); } catch (_) {}

  const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (mdMatch?.[1]) {
    try { return JSON.parse(mdMatch[1].trim()); } catch (_) {}
  }

  const firstBrace   = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const start = [firstBrace, firstBracket].filter((i) => i >= 0).reduce((min, i) => Math.min(min, i), Infinity);
  if (start === Infinity) throw new Error(`Cannot extract JSON: ${raw.slice(0, 100)}`);

  const lastBrace   = raw.lastIndexOf("}");
  const lastBracket = raw.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  if (end < start) throw new Error(`Cannot extract JSON: ${raw.slice(0, 100)}`);

  const candidate = raw.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch (_) {}

  try {
    const escaped = candidate.replace(/(\"(?:[^\"\\]|\\.)*\")/g, (m) =>
      m.replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    );
    return JSON.parse(escaped);
  } catch (_) {}

  throw new Error(`Cannot extract JSON: ${raw.slice(0, 100)}`);
};

module.exports = {
  generateQuizPool,
  selectQuestionsAdaptive,
  processAdaptiveResult,
  extractJSON,
};