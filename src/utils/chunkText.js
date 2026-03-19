/**
 * Hàm đếm số lượng từ trong một văn bản (hỗ trợ tiếng Việt)
 */
const countWords = (str) => {
    return str.trim().split(/\s+/).filter(word => word.length > 0).length;
};

/**
 * Hàm kiểm tra xem một dòng có phải là tiêu đề hay không.
 * Giúp AI chia nhỏ bài học mà không làm đứt đoạn các chương/mục.
 */
const isHeading = (line) => {
    // Detect dạng: "Chương 1", "Phần I", "1.", "1.1", "1.1.1"
    const headingRegex = /^(\d+(\.\d+)*|Chương\s+\d+|Chapter\s+\d+|Phần\s+[IVXLCDM]+|[IVXLCDM]+\.)/i;
    // Detect dòng in hoa hoàn toàn (thường là tiêu đề)
    const isUppercase = line.length > 4 && line === line.toUpperCase();
    return headingRegex.test(line.trim()) || isUppercase;
};

/**
 * Hàm tạo dữ liệu "gối đầu" (Overlap).
 * Lấy một phần cuối của chunk trước dán vào đầu chunk sau để giữ ngữ cảnh cho AI.
 */
const applyOverlap = (chunks, overlapSize) => {
    return chunks.map((content, index) => {
        let finalContent = content;

        if (index > 0) {
            const prevChunkContent = chunks[index - 1];
            const prevWords = prevChunkContent.split(/\s+/);
            // Lấy 100 từ cuối của chunk trước
            const overlapText = prevWords.slice(-overlapSize).join(' ');
            finalContent = `[...Tiếp nối nội dung trước: ${overlapText}] \n\n ${content}`;
        }

        return {
            index: index,
            content: finalContent,
            wordCount: countWords(finalContent)
        };
    });
};

/**
 * HÀM CHÍNH: Chia nhỏ văn bản thô
 */
const chunkText = (rawText) => {
    if (!rawText || typeof rawText !== 'string') return [];

    const MAX_WORDS = 350; // Giới hạn tối đa 1 chunk
    //const MIN_WORDS = 500; // Cố gắng đạt tối thiểu để AI xử lý hiệu quả
    const OVERLAP_SIZE = 50; // Số từ lặp lại giữa các đoạn

    // Bước 1: Chia theo đoạn văn bản để giữ nguyên ý nghĩa câu
    const paragraphs = rawText.split(/\n\s*\n/);
    
    let chunks = [];
    let currentBuffer = [];
    let currentWordCount = 0;

    for (let para of paragraphs) {
        const words = para.trim().split(/\s+/).length;
        if (currentWordCount + words > MAX_WORDS) {
            chunks.push(currentBuffer.join('\n\n'));
            currentBuffer = [para];
            currentWordCount = words;
        } else {
            currentBuffer.push(para);
            currentWordCount += words;
        }
    }
    if (currentBuffer.length > 0) chunks.push(currentBuffer.join('\n\n'));
    
    return chunks.map((c, i) => ({ index: i, content: c, wordCount: c.split(/\s+/).length }));
};
// EXPORT DƯỚI DẠNG OBJECT (Để dùng const { chunkText } = require(...))
module.exports = { chunkText };