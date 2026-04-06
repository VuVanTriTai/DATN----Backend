require('dns').setServers(['1.1.1.1', '8.8.8.8']);
require("dotenv").config();
console.log("--- Kiểm tra Token ---");
console.log("HF_TOKEN có tồn tại không:", process.env.HF_TOKEN ? "CÓ ✅" : "KHÔNG ❌");
console.log("----------------------");
const app = require("./src/app");
const mongoose = require("mongoose");

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI, {
  family: 4
})
.then(() => {
  console.log("DB connected successfully");

  // THÊM ĐOẠN NÀY VÀO: Khởi động server sau khi kết nối DB thành công
  app.listen(PORT, () => {
    console.log(`Server is running at: http://localhost:${PORT}`);
  });
})
.catch((err) => {
  console.log("DB connection error: ", err);
});

