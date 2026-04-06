// services/embeddingService.js
const { pipeline } = require('@xenova/transformers');

let extractor = null;
let loadPromise = null; // Tránh race condition khi nhiều req load cùng lúc

const MAX_CHARS = 1800; // Nhỏ hơn 2000 để tránh cắt đứt giữa token multi-byte

/**
 * Singleton loader — thread-safe với Promise lock
 */
const getExtractor = async () => {
    if (extractor) return extractor;

    // FIX: Nếu đang load thì chờ promise cũ thay vì tạo pipeline mới
    if (!loadPromise) {
        loadPromise = pipeline('feature-extraction', 'Xenova/multilingual-e5-large')
            .then((pipe) => {
                extractor = pipe;
                loadPromise = null;
                return extractor;
            })
            .catch((err) => {
                loadPromise = null; // reset để có thể retry
                throw err;
            });
    }

    return loadPromise;
};

/**
 * Chuẩn bị input theo đúng format E5
 * type: "query" | "passage"
 */
const buildInput = (text, type = 'passage') => {
    const prefix  = type === 'query' ? 'query: ' : 'passage: ';
    const cleaned = text.replace(/\s+/g, ' ').trim().substring(0, MAX_CHARS);
    return prefix + cleaned;
};

/**
 * Embed một text đơn
 */
const generateEmbedding = async (text, type = 'passage') => {
    if (!text?.trim()) throw new Error('Input text is empty');

    const pipe   = await getExtractor();
    const input  = buildInput(text, type);
    const output = await pipe(input, { pooling: 'mean', normalize: true });

    return [...output.data]; // spread nhanh hơn Array.from một chút
};

/**
 * FIX MỚI: Batch embedding — xử lý nhiều texts cùng lúc
 * Giảm overhead load model lặp đi lặp lại
 * @param {string[]} texts
 * @param {'query'|'passage'} type
 * @param {number} batchSize - tuỳ VRAM/RAM của bạn
 */
const generateEmbeddingsBatch = async (texts, type = 'passage', batchSize = 16) => {
    if (!texts?.length) return [];

    const pipe    = await getExtractor();
    const results = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch  = texts.slice(i, i + batchSize);
        const inputs = batch.map((t) => buildInput(t, type));

        // @xenova/transformers hỗ trợ array input
        const outputs = await pipe(inputs, { pooling: 'mean', normalize: true });

        // outputs.data có shape [batchSize, dims] — cần slice từng dòng
        const dims = outputs.data.length / batch.length;
        for (let j = 0; j < batch.length; j++) {
            results.push([...outputs.data.slice(j * dims, (j + 1) * dims)]);
        }
    }

    return results;
};

module.exports = { generateEmbedding, generateEmbeddingsBatch };
