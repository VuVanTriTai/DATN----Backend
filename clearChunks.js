const mongoose = require("mongoose");
const Chunk = require("./src/models/Chunk"); // sửa path nếu cần

const MONGO_URI = "mongodb://127.0.0.1:27017/ten_db_cua_ban"; // 🔥 sửa đúng DB

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected DB");

    const res = await Chunk.deleteMany({});
    console.log(`🔥 Đã xoá ${res.deletedCount} chunks`);

  } catch (err) {
    console.error("❌ Lỗi:", err.message);
  } finally {
    await mongoose.disconnect();
    process.exit();
  }
})();