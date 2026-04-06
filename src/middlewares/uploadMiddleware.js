const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Xác định định dạng file
    const extension = file.originalname.split('.').pop().toLowerCase();
    
    return {
      folder: 'ai_learning_documents',
      // 'raw' là kiểu lưu trữ tốt nhất cho PDF, DOCX, TXT trên Cloudinary
      resource_type: 'raw', 
      public_id: Date.now() + '-' + file.originalname.replace(/\.[^/.]+$/, ""),
      format: extension, // Ép Cloudinary giữ nguyên đuôi file gốc
    };
  },
});

// Bộ lọc kiểm tra file trước khi đẩy lên Cloudinary
const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = [
        'application/pdf',
        'text/plain',
        'application/msword', // .doc
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    ];

    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        // Trả về lỗi rõ ràng thay vì "Unknown format"
        cb(new Error(`Định dạng file ${file.mimetype} không được hỗ trợ.`), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // Tối đa 10MB
});

module.exports = upload;