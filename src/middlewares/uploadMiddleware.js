const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');
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
    // Image support
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'image/svg+xml'
  ];

  if (allowedMimeTypes.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
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

// Helper to zip file
const zipFile = (sourcePath, destPath, fileNameInZip) => {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

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

        try {
          let filePathToUpload = req.file.path;
          const originalSize = req.file.size;
          let resourceType = req.file.mimetype.startsWith('image/') ? 'image' : 'raw';
          let tempFilesToCleanup = [req.file.path];

          // Check size > 10MB
          if (originalSize > 10 * 1024 * 1024) {
            console.log(`[Upload] File is > 10MB (${(originalSize/1024/1024).toFixed(2)}MB). Compressing...`);
            const zippedPath = filePathToUpload + '.zip';
            await zipFile(filePathToUpload, zippedPath, req.file.originalname);
            filePathToUpload = zippedPath;
            tempFilesToCleanup.push(zippedPath);
            req.file.originalname = req.file.originalname + '.zip'; // update name
            req.file.mimetype = 'application/zip';
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
          
          // Cleanup local files
          for (const tempFile of tempFilesToCleanup) {
            if (fs.existsSync(tempFile)) {
              fs.unlinkSync(tempFile);
            }
          }

          console.log(`[Upload] Upload successful: ${result.secure_url}`);
          next();
        } catch (uploadErr) {
          console.error("[Upload] Cloudinary upload error:", uploadErr);
          // Cleanup
          if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          return res.status(500).json({ success: false, message: "File upload failed", error: uploadErr.message });
        }
      });
    };
  }
};

module.exports = { upload, uploadLocal };