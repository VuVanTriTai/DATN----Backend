const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary using env variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)
// cloudinary.config() is automatically populated if CLOUDINARY_URL is present, or individual keys.
// Make sure these are in your .env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Setup local storage for temporary tasks
const localDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/temp';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

// Filter function
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'application/pdf',
    'text/plain',
    'application/msword', 
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', 
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Định dạng file ${file.mimetype} không được hỗ trợ.`), false);
  }
};

const multerLocal = multer({
  storage: localDiskStorage,
  fileFilter: fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

const uploadLocal = multerLocal;

const cleanupTempFiles = (files = []) => {
  const uniqueFiles = [...new Set(files.filter(Boolean))];
  for (const tempFile of uniqueFiles) {
    if (!fs.existsSync(tempFile)) continue;
    try {
      fs.unlinkSync(tempFile);
    } catch (err) {
      console.warn(`[Upload] Cannot cleanup temp file ${tempFile}:`, err.message);
    }
  }
};

// Helper to zip file
const zipFile = (sourcePath, destPath, fileNameInZip) => {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(destPath));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    archive.file(sourcePath, { name: fileNameInZip });
    archive.finalize();
  });
};

// Create a custom upload object that mimics multer's `.single` but processes it to Cloudinary
const upload = {
  single: (fieldName) => {
    return (req, res, next) => {
      // Step 1: Use multer locally first
      multerLocal.single(fieldName)(req, res, async (err) => {
        if (err) return next(err);
        if (!req.file) return next();

        let tempFilesToCleanup = [];
        try {
          let filePathToUpload = req.file.path;
          const originalSize = req.file.size;
          const originalName = req.file.originalname;
          const originalMimeType = req.file.mimetype;
          const originalLocalPath = req.file.path;
          let resourceType = 'raw';
          tempFilesToCleanup = [req.file.path];

          // Check size > 10MB
          if (originalSize > 10 * 1024 * 1024) {
            console.log(`[Upload] File is > 10MB (${(originalSize/1024/1024).toFixed(2)}MB). Compressing...`);
            const zippedPath = filePathToUpload + '.zip';
            await zipFile(filePathToUpload, zippedPath, req.file.originalname);
            filePathToUpload = zippedPath;
            tempFilesToCleanup.push(zippedPath);
          }

          // Step 2: Upload to Cloudinary
          console.log(`[Upload] Uploading ${req.file.originalname} to Cloudinary...`);
          const result = await cloudinary.uploader.upload(filePathToUpload, {
            resource_type: resourceType,
            folder: 'ai_learning_documents',
            use_filename: true,
            unique_filename: true
          });

          // Update req.file properties to match expected behavior in controllers
          req.file.path = result.secure_url;
          req.file.location = result.secure_url; // Some controllers use location
          req.file.cloudinaryId = result.public_id;
          req.file.localPath = originalLocalPath;
          req.file.originalname = originalName;
          req.file.mimetype = originalMimeType;

          res.once('finish', () => cleanupTempFiles(tempFilesToCleanup));
          res.once('close', () => cleanupTempFiles(tempFilesToCleanup));

          console.log(`[Upload] Upload successful: ${result.secure_url}`);
          next();
        } catch (uploadErr) {
          console.error("[Upload] Cloudinary upload error:", uploadErr);
          // Cleanup
          cleanupTempFiles(tempFilesToCleanup.length ? tempFilesToCleanup : [req.file?.path]);
          return res.status(500).json({ success: false, message: "File upload failed", error: uploadErr.message });
        }
      });
    };
  }
};

module.exports = { upload, uploadLocal };
