// =========================================================================
// 👨‍🍳 FILE: src/controllers/planController.js - BỘ ĐIỀU PHỐI TẠO KHÓA HỌC (PLAN CONTROLLER)
// Tác dụng: Nhận yêu cầu tạo lộ trình học tập từ Frontend, gọi các dịch vụ AI và lưu kết quả.
// Luồng đi: FE → planRoutes → planController → planService (AI) → MongoDB
// =========================================================================

// 📦 IMPORT CÁC DỊCH VỤ & UTILITIES
const planService = require('../services/planService');    // Dịch vụ AI sinh bài giảng, phân tích tài liệu
const { normalizeLearningGoals } = require('../constants/learningGoals'); // Chuẩn hóa mục tiêu học
const { extractTextFromFile } = require('../utils/extractText'); // Trích xuất text từ file PDF/Word
const { saveDebugLessons } = require('../utils/debugLessons'); // Ghi log bài học ra file debug
const lessonReuseService = require('../services/lessonReuseService'); // Tái sử dụng bài giảng cũ
const { extractConcepts, mergeConcepts } = require('../utils/conceptExtractor'); // Trích khái niệm dạy được

// 🗄️ IMPORT CÁC MODEL MONGODB
const Plan = require('../models/Plan');           // Lộ trình học
const Lesson = require('../models/Lesson');       // Bài học từng ngày
const Chunk = require('../models/Chunk');         // Đoạn văn bản nhỏ (dùng cho RAG)
const Enrollment = require('../models/Enrollment'); // Liên kết học viên - giáo viên
const Document = require('../models/Document');   // Tài liệu gốc người dùng tải lên
const Assignment = require('../models/Assignment'); // Bài tập tự luận
const Progress = require('../models/Progress');   // Tiến độ học
const User = require('../models/User');           // Thông tin người dùng

// 🔐 Thư viện mã hóa của Node.js (dùng để tạo hash MD5 chống trùng lặp tài liệu)
// ✅ FIX: Đã chuyển require('crypto') từ trong function body lên đầu file theo chuẩn Node.js
const crypto = require('crypto');

// ⚠️ FIX đã xóa: Import GROQ_KEY_COUNT từ planService (biến này không được export từ planService)
// const { GROQ_KEY_COUNT } = require('../services/planService'); // ← điều này gây ra undefined!

// ────────────────────────────────────────────────────────────
// PARALLEL LESSON GENERATOR
// Sinh nhiều ngày học song song, mỗi key xử lý 1 batch để tránh RPM
// ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 🔄 HÀM SINH BÀI HỌC TUẦN TỰ CÓ BỘ NHỚ KHÁI NIỆM (generateLessonsParallel)
//
// Tên hàm là "Parallel" nhưng thực chất chạy TUẦN TỰ từng ngày.
// Lý do: Mỗi ngày học cần biết khái niệm đã dạy ở ngày trước (concept memory)
//        để AI không lặp lại kiến thức → buộc phải đợi ngày trước xong mới làm ngày sau.
//
// Tham số nhận vào:
//   - syllabus     : Mảng khung chương trình [{day, title, objective, ...}]
//   - plan         : Bản ghi Plan đã được lưu vào MongoDB
//   - learnerId    : ID học viên (để kiểm tra tái sử dụng bài học cũ)
//   - learningGoals: Mục tiêu học (lý thuyết/thực hành, cơ bản/nâng cao)
//   - duration     : Tổng số ngày học
// ─────────────────────────────────────────────────────────────────────────────
const generateLessonsParallel = async ({
  syllabus, plan, learnerId, learningGoals, duration
}) => {
  console.log(`📚 Lesson gen: SEQUENTIAL + Concept Memory | ${syllabus.length} ngày`);

  // Tạo danh sách tóm tắt toàn bộ chương trình để AI hiểu "bức tranh tổng thể" khi sinh từng ngày
  const syllabusContext = syllabus.map(item => ({
    day: item.dayNumber || item.day,
    title: item.title,
    summary: item.objective || "",
  }));

  // Danh sách "chữ ký" của các đoạn văn bản đã dùng (tránh AI lấy cùng 1 đoạn 2 lần)
  const usedChunkSignatures = [];

  // 🧠 BỘ NHỚ KHÁI NIỆM (Concept Memory): Tích lũy toàn bộ khái niệm đã dạy qua các ngày
  // Mục đích: Ngày 3 sẽ biết ngày 1 và 2 đã dạy gì → không giải thích lại từ đầu
  let usedConcepts = [];
  let reuseCount = 0;
  const results = [];

  // Vòng lặp tuần tự: xử lý từng ngày học một, theo đúng thứ tự
  for (const item of syllabus) {

    // Chuẩn hóa thông tin ngày học hiện tại (syllabus từ AI có thể dùng 'dayNumber' hoặc 'day')
    const currentItem = {
      day: item.dayNumber || item.day,
      topic: item.title,
      objective: item.objective || "",
      bloomLevel: item.bloomLevel || "",      // Mức độ tư duy (Bloom Taxonomy)
      coveredSections: item.coveredSections || [],  // Các phần tài liệu gốc cần bao quát
      totalDays: duration,
    };

    console.log(
      `> Day ${currentItem.day}: "${currentItem.topic}" | ` +
      `sections=${currentItem.coveredSections.length} | ` +
      `memory=${usedConcepts.length} concepts`
    );

    try {
      // ── KIỂM TRA TÁI SỬ DỤNG BÀI GIẢNG CŨ ─────────────────────────────
      // Tìm bài học tương tự đã từng tạo cho học viên này ở khóa học khác.
      // Nếu trùng khớp → nhân bản (clone) thay vì gọi AI → tiết kiệm thời gian & tiền API.
      let reused = null;
      try {
        reused = await lessonReuseService.findReusableLesson(
          learnerId, currentItem.topic, currentItem.objective,
          { currentPlanId: plan._id }
        );
      } catch (e) { console.warn("⚠️ Reuse check failed:", e.message); }

      // Trường hợp 1: Bài học giống hoàn toàn → Copy nguyên si, không cần sinh mới
      if (reused && reused.action === "REUSE_NGUYEN") {
        await lessonReuseService.cloneLesson(
          reused.lesson, plan._id, currentItem.day,
          { version: reused.lesson.version, missingCoverage: [] }
        );
        reuseCount++;
        // Vẫn phải cập nhật concept memory từ bài tái sử dụng để ngày tiếp theo biết
        const reusedConcepts = extractConcepts(reused.lesson.content || "", currentItem.topic);
        usedConcepts = mergeConcepts(usedConcepts, reusedConcepts);
        console.log(`♻️  REUSE NGUYÊN Day ${currentItem.day} | +${reusedConcepts.length} concepts`);
        results.push({ day: currentItem.day, title: currentItem.topic, summary: reused.lesson.summary || currentItem.objective, reused: true });
        continue; // Bỏ qua phần sinh mới bên dưới, qua ngày tiếp theo
      }

      // Trường hợp 2: Bài học gần giống, cần cập nhật thêm phần thiếu → Patch bổ sung
      if (reused && reused.action === "REUSE_UPDATE") {
        await lessonReuseService.patchLesson(
          reused.lesson, plan._id, currentItem.day,
          reused.diff.missingCoverage || [], reused.newContext, reused.lesson.version
        );
        reuseCount++;
        const reusedConcepts = extractConcepts(reused.lesson.content || "", currentItem.topic);
        usedConcepts = mergeConcepts(usedConcepts, reusedConcepts);
        console.log(`♻️  REUSE+UPDATE Day ${currentItem.day} | +${reusedConcepts.length} concepts`);
        results.push({ day: currentItem.day, title: currentItem.topic, summary: reused.lesson.summary || currentItem.objective, reused: true });
        continue;
      }

      // Trường hợp 3 (REWRITE hoặc không có bài cũ): Sinh bài học mới hoàn toàn bằng AI
      if (reused?.action === "REWRITE") console.log(`♻️  REWRITE: Day ${currentItem.day}`);

      // ── GỌI AI SINH BÀI GIẢNG MỚI (kết hợp RAG + Concept Memory) ────────
      // Truyền vào: planId, thông tin ngày, học viên, danh sách chunk đã dùng,
      //             mục tiêu học, tóm tắt các ngày trước, và bộ nhớ khái niệm
      const detail = await planService.generateScientificLesson(
        plan._id,
        currentItem,
        learnerId,
        [],                   // previousTopics (không dùng nữa, thay bằng previousSummaries)
        usedChunkSignatures,
        learningGoals,
        syllabusContext.filter(s => s.day < currentItem.day), // Chỉ truyền ngày đã qua
        usedConcepts          // Toàn bộ khái niệm đã dạy từ ngày 1 đến ngày hiện tại
      );

      // Cập nhật danh sách chunk đã sử dụng (để ngày sau tìm chunk mới, không bị trùng)
      if (Array.isArray(detail.usedChunkSignatures)) {
        for (const sig of detail.usedChunkSignatures) {
          if (!usedChunkSignatures.includes(sig)) usedChunkSignatures.push(sig);
        }
      }

      // Tích lũy thêm khái niệm mới vừa dạy trong ngày hôm nay vào bộ nhớ
      if (Array.isArray(detail.newConcepts) && detail.newConcepts.length) {
        const before = usedConcepts.length;
        usedConcepts = mergeConcepts(usedConcepts, detail.newConcepts);
        const added = usedConcepts.length - before;
        console.log(
          `🧠 Day ${currentItem.day}: taught [${detail.newConcepts.slice(0, 6).join(", ")}` +
          `${detail.newConcepts.length > 6 ? "..." : ""}] | +${added} new | total: ${usedConcepts.length}`
        );
      }

      // ── LƯU BÀI HỌC VÀO DATABASE ─────────────────────────────────────────
      // Ngày 1 mở khóa ngay (in-progress), các ngày sau khóa lại (locked)
      // Học viên phải hoàn thành ngày trước mới mở được ngày tiếp theo
      const newLesson = await Lesson.create({
        planId: plan._id,
        dayNumber: currentItem.day,
        title: currentItem.topic,
        content: detail.content,           // Nội dung Markdown đầy đủ
        summary: detail.summary,           // Tóm tắt ngắn gọn
        quiz: detail.quiz || [],           // Câu hỏi trắc nghiệm
        importantNotes: detail.importantNotes || [],
        status: currentItem.day === 1 ? "in-progress" : "locked",
      });

      await lessonReuseService.indexLesson(newLesson, plan).catch(() => { });
      console.log(`✅ Day ${currentItem.day} done`);

      results.push({
        day: currentItem.day,
        title: currentItem.topic,
        summary: detail.summary || currentItem.objective,
      });

      if (currentItem.day < duration) await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      console.error(`❌ Lesson ${currentItem.day} error:`, err.message);
      await Lesson.create({
        planId: plan._id,
        dayNumber: currentItem.day,
        title: currentItem.topic,
        content: `## ${currentItem.topic}\n\nNội dung bài học này đang gặp sự cố.\nBạn có thể thử lại hoặc chỉnh sửa thủ công.`,
        summary: "Lỗi hệ thống AI",
        quiz: [],
        importantNotes: [],
        status: "locked",
      });
      results.push({ day: currentItem.day, title: currentItem.topic, summary: currentItem.objective, error: err.message });
    }
  }

  console.log(`♻️  Reused: ${reuseCount}/${syllabus.length} | Final memory: ${usedConcepts.length} concepts`);
  return results;
};


const DAYS_MIN = 1;
const DAYS_MAX = 14;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// ─────────────────────────────────────────────
// UPLOAD & EXTRACT (HARDENED)
// ─────────────────────────────────────────────

const uploadAndExtract = async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "Không có file được tải lên.",
      });
    }

    // ─────────────────────────────
    // FIX-1: VALIDATE FILE TYPE
    // ─────────────────────────────
    const allowedTypes = [
      "application/pdf",
      "text/plain",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: "Định dạng file không được hỗ trợ.",
      });
    }

    // ─────────────────────────────
    // FIX-2: LIMIT SIZE (safety)
    // ─────────────────────────────
    const MAX_SIZE_MB = 10;
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: `File vượt quá ${MAX_SIZE_MB}MB.`,
      });
    }

    console.log(`📁 Extracting: ${file.originalname}`);

    // ─────────────────────────────
    // FIX-3: SAFE EXTRACTION
    // ─────────────────────────────
    const result = await extractTextFromFile(file) || {};
    const text = (result.text || "").trim();
    const metadata = result.metadata || {};

    // ─────────────────────────────
    // FIX-4: TEXT VALIDATION (stronger)
    // ─────────────────────────────
    const wordCount = text.split(/\s+/).length;

    if (!text || wordCount < 30) {
      return res.status(400).json({
        success: false,
        message: "File không chứa đủ nội dung hợp lệ.",
      });
    }

    // detect text rác (optional nhưng rất hữu ích)
    const junkRatio = (text.match(/[^a-zA-Z0-9À-ỹ\s]/g) || []).length / text.length;
    if (junkRatio > 0.4) {
      console.warn("⚠️ Text có dấu hiệu OCR lỗi / rác");
    }

    // ─────────────────────────────
    // FIX-5: SAFE METADATA
    // ─────────────────────────────
    const safeMeta = {
      wordCount: metadata.wordCount || wordCount,
      tableCount: metadata.tableCount || 0,
      hasFormulas: metadata.hasFormulas || false,
      estimatedComplexity: metadata.estimatedComplexity || "unknown",
    };

    console.log(
      `✅ Extracted: ${safeMeta.wordCount} words | tables=${safeMeta.tableCount} | complexity=${safeMeta.estimatedComplexity}`
    );

    // ─────────────────────────────
    // FIX-6: LIMIT RESPONSE SIZE
    // ─────────────────────────────
    const MAX_RETURN_CHARS = 15000;

    return res.status(200).json({
      success: true,
      message: "Đã trích xuất nội dung thành công.",
      data: {
        textPreview: text.substring(0, MAX_RETURN_CHARS), // ⚠️ chỉ preview
        fullLength: text.length,
        metadata: safeMeta,
        fileUrl: file.path,
        originalName: file.originalname,
      },
    });

  } catch (error) {
    console.error("❌ Upload & Extract error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể đọc file. Vui lòng thử lại.",
    });
  }
};// ─────────────────────────────────────────────
// PROCESS & ANALYZE (HARDENED)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 🧠 PHÂN TÍCH TÀI LIỆU & ĐỊNH HƯỚNG MỤC TIÊU HỌC TẬP (PROCESS & ANALYZE)
// Luồng hoạt động: Frontend gửi text trích xuất -> validate độ dài -> gọi planService.analyzeDocument
// để phân tích độ phức tạp, chủ đề chính, và đề xuất lộ trình khung (previewPlan).
// ─────────────────────────────────────────────────────────────────────────────
const processAndAnalyze = async (req, res) => {
  try {
    let {
      text,
      learningGoals: rawGoals,
      days,
      metadata,
    } = req.body;

    // BƯỚC 1: Xác thực tính hợp lệ của văn bản gửi lên
    if (!text || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        message: "Không nhận được nội dung văn bản hợp lệ.",
      });
    }

    text = text.trim();

    // Giới hạn độ dài tối đa để tránh quá tải token khi gọi LLM API (50,000 ký tự)
    const MAX_TEXT_LENGTH = 50000;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.substring(0, MAX_TEXT_LENGTH);
      console.warn("⚠️ Text bị cắt do quá dài");
    }

    const wordCount = text.split(/\s+/).length;
    if (wordCount < 30) {
      return res.status(400).json({
        success: false,
        message: "Nội dung quá ngắn để phân tích.",
      });
    }

    // BƯỚC 2: Kiểm tra số ngày mong muốn học (Duration) - Giới hạn từ 1 đến 14 ngày
    const DAYS_MIN = 1;
    const DAYS_MAX = 14;

    let safeDays = parseInt(days) || 7;
    safeDays = Math.max(DAYS_MIN, Math.min(DAYS_MAX, safeDays));

    // BƯỚC 3: Thiết lập metadata an toàn
    const safeMetadata = {
      wordCount: metadata?.wordCount || wordCount,
      tableCount: metadata?.tableCount || 0,
      hasFormulas: metadata?.hasFormulas || false,
      estimatedComplexity: metadata?.estimatedComplexity || "unknown",
    };

    console.log(`🧠 Analyze: ${safeMetadata.wordCount} words | days=${safeDays}`);

    // BƯỚC 4: Gọi nghiệp vụ phân tích tài liệu bằng AI (planService.analyzeDocument)
    const result = await planService.analyzeDocument(
      text,
      rawGoals || {},
      safeDays,
      safeMetadata
    );

    // BƯỚC 5: Trả về kết quả phân tích sơ bộ cùng lộ trình khung cho người học xem trước
    return res.success(
      {
        textPreview: text.substring(0, 10000), // Chỉ trả về preview tránh nặng đường truyền
        textLength: text.length,
        analysis: result.analysis,
        previewPlan: result.previewPlan,
        metadata: safeMetadata,
      },
      "Phân tích tài liệu và thiết lập mục tiêu thành công."
    );

  } catch (error) {
    console.error("❌ ProcessAndAnalyze error:", error);
    return res.error(
      "AI gặp sự cố khi xử lý bối cảnh học tập.",
      500
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 🚀 XÁC NHẬN KHỞI TẠO KHÓA HỌC HOÀN CHỈNH (FINALIZE CREATE COURSE)
// Luồng hoạt động:
// 1. Kiểm tra chất lượng tài liệu học (docValidationService)
// 2. Hash MD5 tài liệu để chống trùng lặp, lưu trữ tài liệu gốc (Document)
// 3. Khởi tạo bản ghi lộ trình chính (Plan) và bản ghi theo học (Enrollment)
// 4. Chia nhỏ tài liệu thành từng phần (Chunking) và tính toán Vector Embedding (RAG)
// 5. Sinh Khung chương trình chi tiết (Syllabus)
// 6. Chạy vòng lặp sinh nội dung chi tiết bài giảng từng ngày (generateLessonsParallel)
// ─────────────────────────────────────────────────────────────────────────────
const finalizeCreateCourse = async (req, res) => {
  try {
    const {
      title,
      extractedText,
      numDays,
      instructorId,
      previewPlan,
      fileUrl,
      learningGoals: rawGoals,
      metadata
    } = req.body;

    const learnerId = req.user.id;
    // crypto đã được khai báo ở đầu file (không cần require lại)
    const learningGoals = normalizeLearningGoals(rawGoals || {});

    if (!extractedText) {
      return res.error("Thiếu nội dung tài liệu.", 400);
    }

    // BƯỚC 1: KIỂM TRA CHẤT LƯỢNG TÀI LIỆU (Validate quality, rác chữ, OCR lỗi)
    let validationWarnings = [];
    let depthGapWarning = null;
    try {
      const { validateDocument } = require('../services/docValidationService');
      const valResult = await validateDocument(extractedText, {
        focus: learningGoals.focus || 'theory',
        depth: learningGoals.depth || 'basic'
      });

      console.log('📋 Doc validation:', valResult.level, '| issues:', valResult.issues.length);

      if (!valResult.passed) {
        return res.status(400).json({
          success: false,
          message: valResult.issues[0] || 'Tài liệu không đạt yêu cầu chất lượng.',
          validationIssues: valResult.issues,
          validationLevel: valResult.level,
          metrics: valResult.metrics,
        });
      }

      validationWarnings = valResult.issues;
      depthGapWarning = valResult.depthGapWarning;
    } catch (valErr) {
      console.warn('⚠️ Doc validation service lỗi, bỏ qua:', valErr.message);
    }

    // BƯỚC 2: HASH MD5 TÀI LIỆU (Chống trùng lặp tài liệu gốc trong Database)
    const hash = crypto.createHash("md5").update(extractedText).digest("hex");

    let doc = await Document.findOne({ userId: learnerId, contentHash: hash });
    if (!doc) {
      doc = await Document.create({
        userId: learnerId,
        title: title || metadata?.fileName || "Tài liệu gốc",
        content: extractedText,
        fileUrl: fileUrl,
        contentHash: hash,
        metadata: metadata || {}
      });
      console.log("📄 Đã lưu tài liệu mới.");
    } else {
      console.log("📄 Tài liệu đã tồn tại, dùng lại ID:", doc._id);
    }

    if (metadata) {
      console.log(
        `📊 Document info: ${metadata?.wordCount || 0} words, ` +
        `${metadata?.tableCount || 0} table rows, ` +
        `formulas: ${metadata?.hasFormulas ? 'Yes' : 'No'}, ` +
        `complexity: ${metadata?.estimatedComplexity || 'unknown'}`
      );
    }

    // BƯỚC 3: CHUẨN HÓA SỐ NGÀY HỌC (DURATION NORMALIZE)
    let duration = parseInt(numDays);
    if (isNaN(duration)) {
      const match = String(numDays).match(/\d+/);
      duration = match ? parseInt(match[0]) : 7;
    }
    duration = Math.min(DAYS_MAX, Math.max(DAYS_MIN, duration));

    console.log("🚀 BẮT ĐẦU QUY TRÌNH TẠO LỘ TRÌNH RAG");

    // BƯỚC 4: KHỞI TẠO BẢN GHI LỘ TRÌNH CHÍNH (CREATE PLAN)
    // Lưu các cài đặt như cấp độ, mục tiêu thực hành/lý thuyết, người hướng dẫn được giao.
    const plan = await Plan.create({
      title: title || metadata?.fileName || "Khóa học AI",
      owner: learnerId,
      instructorId: instructorId || null,
      documentId: doc._id,
      duration,
      learningFocus: learningGoals?.focus || 'theory',
      learningDepth: learningGoals?.depth || 'basic',
      documentMetadata: {
        wordCount: metadata?.wordCount || 0,
        hasFormulas: metadata?.hasFormulas || false,
        complexity: metadata?.estimatedComplexity || 'medium'
      },
    });

    // BƯỚC 5: TẠO BẢN GHI THEO DÕI HỌC TẬP (ENROLLMENT)
    // Nếu khóa học này có giáo viên hướng dẫn, tự động tạo liên kết chờ xác nhận của GV.
    if (plan.instructorId) {
      await Enrollment.create({
        learnerId,
        instructorId: plan.instructorId,
        planId: plan._id,
        status: "pending"
      });
    }

    // BƯỚC 6: CẮT NHỎ VÀ EMBEDDING TÀI LIỆU (CHUNKING & VECTOR STORAGE)
    // Chia tài liệu thành các đoạn text ngắn (chunks), tạo mã vector cho từng đoạn qua OpenAI/HuggingFace
    // và lưu vào Vector Store để sau này truy vấn tìm kiến thức chính xác theo từng ngày (RAG).
    console.log("📦 Chunk + embedding...");
    await planService.processAndStoreDocument(plan._id, extractedText);

    console.log("⏳ Đợi index (5s)...");
    await sleep(5000);

    // BƯỚC 7: XÂY DỰNG KHUNG CHƯƠNG TRÌNH HỌC (GENERATE SYLLABUS)
    // Nếu người dùng chọn dùng luôn đề xuất ban đầu (previewPlan), hệ thống sẽ giữ nguyên.
    // Nếu không, AI sẽ dựa trên toàn bộ tài liệu để phân bổ khối lượng kiến thức đều ra số ngày học.
    const previewMatchesDuration =
      Array.isArray(previewPlan) && previewPlan.length === duration;

    const syllabus = previewMatchesDuration
      ? previewPlan
      : (await planService.generateSyllabus(extractedText, duration, learningGoals)).syllabus;

    if (!Array.isArray(syllabus) || syllabus.length === 0) {
      throw new Error("Syllabus generation failed hoặc rỗng.");
    }

    console.log(`📚 Tạo ${syllabus.length} bài học`);

    // BƯỚC 8: VÒNG LẶP SINH NỘI DUNG CHI TIẾT TỪNG NGÀY (LESSON GENERATION LOOP)
    // Hệ thống chạy tuần tự từng ngày học để chuyển tiếp "Bộ nhớ khái niệm đã học" (concept memory),
    // giúp bài học ngày thứ 2 không bị trùng lặp kiến thức của ngày 1 mà phát triển kế thừa.
    await generateLessonsParallel({ syllabus, plan, learnerId, learningGoals, duration });


    // ✅ DEBUG: Ghi nội dung các ngày học ra file phục vụ giám sát/gỡ lỗi
    try {
      const createdLessons = await Lesson.find({ planId: plan._id, isDeleted: false })
        .sort({ dayNumber: 1 })
        .lean();
      saveDebugLessons(plan, createdLessons);
    } catch (debugErr) {
      console.warn("⚠️ [debug] Không ghi được debug_lessons.txt:", debugErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Lộ trình học tập đã sẵn sàng!",
      data: {
        _id: plan._id,
        metadata,
        validationWarnings: validationWarnings || [],
        depthGapWarning: depthGapWarning || null,
      }
    });

  } catch (error) {
    console.error("🔥 Controller error:", error.stack);
    return res.status(500).json({
      success: false,
      message: "Không thể khởi tạo khóa học: " + error.message
    });
  }
};
/////////////////////////////////////////
// ───────────────────────────────────────────
// EXISTING FUNCTIONS — FIXED & HARDENED
// ───────────────────────────────────────────
const getMyPlans = async (req, res) => {
  try {
    const userId = req.user.id;

    const plans = await Plan.find({
      owner: userId,
      isDeleted: false,
      deletedByOwner: { $ne: true },
      status: { $ne: "teaching" } // Ẩn bản clone đang được giáo viên giữ
    }).lean();

    const plansWithProgress = await Promise.all(
      plans.map(async (plan) => {
        const totalLessons = Math.max(plan.duration || 1, 1);

        const completedCount = await Lesson.countDocuments({
          planId: plan._id,
          status: "completed",
        });

        const progressPercent = Math.min(
          100,
          Math.round((completedCount / totalLessons) * 100)
        );

        return {
          ...plan,
          progress: progressPercent,
          sourceType: plan.sourceType || "self",
        };
      })
    );

    return res.success(plansWithProgress);
  } catch (err) {
    console.error("getMyPlans error:", err);
    return res.error(err.message);
  }
};

const getPlanDetails = async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id)
      .populate("documentId")
      .populate("instructorId", "fullName email instructorProfile");

    if (!plan) return res.error("Không tìm thấy lộ trình", 404);

    const lessons = await Lesson.find({
      planId: req.params.id,
      isDeleted: false,
    }).sort({ dayNumber: 1 });

    return res.success({ plan, lessons });
  } catch (error) {
    console.error("getPlanDetails error:", error);
    return res.error(error.message, 500);
  }
};

const getLessonDetail = async (req, res) => {
  try {
    const lesson = await Lesson.findOne({
      planId: req.params.id,
      dayNumber: Number(req.params.dayNumber),
    });

    if (!lesson) return res.error("Không tìm thấy bài học", 404);

    return res.success(lesson);
  } catch (error) {
    console.error("getLessonDetail error:", error);
    return res.error(error.message, 500);
  }
};

const deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const plan = await Plan.findOne({
      _id: id,
      $or: [{ owner: userId }, { instructorId: userId }, { sharedWith: userId }]
    });
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy lộ trình hoặc bạn không có quyền xóa.",
      });
    }

    const isOwner = plan.owner && plan.owner.toString() === userId;
    const isInstructor = plan.instructorId && plan.instructorId.toString() === userId;
    const isRecipient = plan.sharedWith && plan.sharedWith.includes(userId);

    // Xử lý nếu chỉ là người nhận chia sẻ
    if (!isOwner && !isInstructor && isRecipient) {
      plan.sharedWith = plan.sharedWith.filter(id => id.toString() !== userId);
      await plan.save();
      return res.status(200).json({
        success: true,
        message: "Đã xóa lộ trình khỏi hộp thư chia sẻ.",
      });
    }

    if (isOwner) {
      plan.deletedByOwner = true;
    }
    if (isInstructor) {
      plan.deletedByInstructor = true;
    }

    await plan.save();

    // Nếu không có giáo viên HOẶC cả 2 đều đã xóa thì mới xóa cứng (hard delete)
    const shouldHardDelete = plan.deletedByOwner && (!plan.instructorId || plan.deletedByInstructor);

    if (shouldHardDelete) {
      console.log(`🗑️ Cả 2 phía đã xóa, tiến hành xóa cứng lộ trình: ${id}`);
      await Promise.all([
        Lesson.deleteMany({ planId: id }),
        Chunk.deleteMany({ planId: id }),
        Enrollment.deleteMany({ planId: id }),
        Assignment.deleteMany({ planId: id }),
        Progress.deleteMany({ planId: id }),
      ]);
      await Plan.findByIdAndDelete(id);
      console.log("✅ Đã xóa cứng toàn bộ dữ liệu liên quan.");
    } else {
      console.log(`👁️ Ẩn lộ trình ${id} khỏi màn hình của user ${userId}`);
    }

    return res.status(200).json({
      success: true,
      message: "Đã xóa lộ trình khỏi danh sách của bạn.",
    });
  } catch (error) {
    console.error("🔥 deletePlan error:", error);
    return res.status(500).json({
      success: false,
      message: "Lỗi hệ thống: " + error.message,
    });
  }
};

const sharePlan = async (req, res) => {
  try {
    const plan = await Plan.findByIdAndUpdate(
      req.params.id,
      { isPublic: true },
      { new: true }
    );

    if (!plan) return res.error("Không tìm thấy lộ trình", 404);

    return res.success(plan, "Đã chia sẻ lộ trình.");
  } catch (error) {
    console.error("sharePlan error:", error);
    return res.error(error.message, 500);
  }
};

const updateInstructor = async (req, res) => {
  try {
    const { id } = req.params;
    const { instructorId } = req.body;
    const userId = req.user.id;

    // 1. Lấy lộ trình gốc
    const originalPlan = await Plan.findById(id);
    if (!originalPlan) return res.error("Không tìm thấy lộ trình gốc", 404);

    if (!instructorId) {
      // Học viên chọn "Không chọn (Tự học)" -> Gỡ giáo viên khỏi lộ trình gốc
      const plan = await Plan.findByIdAndUpdate(
        id,
        { $unset: { instructorId: 1 } },
        { new: true }
      );
      await Enrollment.deleteMany({ learnerId: userId, planId: id });
      return res.success(plan, "Đã gỡ người hướng dẫn.");
    }

    // 2. Tạo bản clone cho giáo viên
    const planData = originalPlan.toObject();
    delete planData._id;
    delete planData.createdAt;
    delete planData.updatedAt;

    const clonedPlan = new Plan({
      ...planData,
      instructorId: instructorId,
      status: "teaching",     // Đang chờ giáo viên duyệt
      sourceType: "assigned", // Sẽ vào tab "Giáo viên gửi" khi duyệt xong
    });
    await clonedPlan.save();

    // 3. Clone tất cả các Lesson của lộ trình
    const originalLessons = await Lesson.find({ planId: id });
    if (originalLessons.length > 0) {
      const newLessons = originalLessons.map((lesson) => {
        const lessonData = lesson.toObject();
        delete lessonData._id;
        delete lessonData.createdAt;
        delete lessonData.updatedAt;
        return {
          ...lessonData,
          planId: clonedPlan._id,
          status: lessonData.dayNumber === 1 ? "in-progress" : "locked",
        };
      });
      await Lesson.insertMany(newLessons);
    }

    // 4. Tạo Enrollment cho bản clone
    await Enrollment.create({
      learnerId: userId,
      instructorId: instructorId,
      planId: clonedPlan._id,
      status: "active", // Đặt active luôn để hiện trong danh sách học viên của giáo viên
    });

    // 5. Cập nhật ID giáo viên vào lộ trình gốc để học viên biết là đã gửi
    await Plan.findByIdAndUpdate(id, { instructorId });

    return res.success(clonedPlan, "Đã gửi bản sao lộ trình cho người hướng dẫn.");


  } catch (error) {
    console.error("updateInstructor error:", error);
    return res.error(error.message, 500);
  }
};

const shareToMarket = async (req, res) => {
  try {
    const { id } = req.params;
    const { categories = [], level = "basic", tags = [] } = req.body;

    const normalizedTags = tags.map((t) =>
      String(t).toLowerCase().trim()
    );

    const plan = await Plan.findOneAndUpdate(
      { 
        _id: id, 
        $or: [
          { owner: req.user.id },
          { instructorId: req.user.id }
        ]
      },
      {
        isPublic: true,
        categories,
        level,
        tags,
        normalizedTags,
      },
      { new: true }
    );

    if (!plan)
      return res.error(
        "Không tìm thấy lộ trình hoặc bạn không có quyền chia sẻ",
        404
      );

    lessonReuseService
      .syncPlanPublicStatus(id, true)
      .catch((e) =>
        console.warn("[shareToMarket] sync failed:", e.message)
      );

    return res.success(plan, "Đã đăng lên Market thành công!");
  } catch (error) {
    console.error("shareToMarket error:", error);
    return res.error(error.message, 500);
  }
};

const getPlanResults = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const progress = await Progress.findOne({ userId, planId: id });

    const lessons = await Lesson.find({
      planId: id,
      isDeleted: false,
    })
      .select("dayNumber title quiz")
      .sort({ dayNumber: 1 });

    if (!lessons.length)
      return res.error("Lộ trình chưa có bài học nào.", 404);

    const detailedResults = lessons.map((lesson) => {
      const knowledge = progress?.knowledgeMap?.find(
        (k) => k.topic === lesson.title
      );

      return {
        dayNumber: lesson.dayNumber,
        title: lesson.title,
        isCompleted:
          progress?.completedDays?.includes(lesson.dayNumber) || false,
        score: knowledge ? Math.round(knowledge.score) : 0,
        status: knowledge ? knowledge.status : "NOT_STARTED",
      };
    });

    const totalLessons = lessons.length;
    const completedCount = progress?.completedDays?.length || 0;

    const summary = {
      overallProgress: totalLessons
        ? Math.round((completedCount / totalLessons) * 100)
        : 0,
      averageScore: progress ? Math.round(progress.averageScore || 0) : 0,
      currentLevel: progress?.currentLevel || "BEGINNER",
      totalLessons,
      completedCount,
    };

    return res.success({ summary, detailedResults });
  } catch (error) {
    console.error("getPlanResults error:", error);
    return res.error(error.message, 500);
  }
};

const searchUser = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.error("Thiếu email", 400);

    const user = await User.findOne({
      email: email.toLowerCase(),
    }).select("fullName email");

    if (!user) return res.error("Không tìm thấy người dùng", 404);

    return res.success(user);
  } catch (error) {
    console.error("searchUser error:", error);
    return res.error(error.message, 500);
  }
};

const sharePrivate = async (req, res) => {
  try {
    const { id } = req.params;
    const { targetUserId } = req.body;

    const plan = await Plan.findById(id);
    if (!plan || plan.owner.toString() !== req.user.id) {
      return res.error("Bạn không có quyền chia sẻ lộ trình này", 403);
    }

    if (!plan.sharedWith.includes(targetUserId)) {
      plan.sharedWith.push(targetUserId);
      await plan.save();
    }

    return res.success(null, "Đã chia sẻ thành công!");
  } catch (error) {
    console.error("sharePrivate error:", error);
    return res.error(error.message, 500);
  }
};

const getSharedWithMe = async (req, res) => {
  try {
    const userId = req.user.id;

    const plans = await Plan.find({
      sharedWith: userId,
      owner: { $ne: userId },
    })
      .populate("owner", "fullName email")
      .sort({ createdAt: -1 });

    console.log(`📋 Found ${plans.length} shared plans`);

    return res.success(plans);
  } catch (error) {
    console.error("getSharedWithMe error:", error);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
  // Upload + Analyze
  uploadAndExtract,
  processAndAnalyze,
  finalizeCreateCourse,

  // Plan
  getMyPlans,
  getPlanDetails,
  deletePlan,
  sharePlan,
  shareToMarket,

  // Lesson
  getLessonDetail,
  getPlanResults,

  // Instructor
  updateInstructor,

  // Sharing
  searchUser,
  sharePrivate,
  getSharedWithMe,
};