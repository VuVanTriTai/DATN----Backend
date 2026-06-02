// src/configs/database.js
// Cấu hình kết nối MongoDB bằng Mongoose
// MONGODB_URI được lưu trong .env để bảo mật thông tin kết nối
// Cách sử dụng: Gọi connectDB() trong file src/index.js 
// //trước khi khởi động server
//thiết lập kết nối giữa ứng dụng Node.js của bạn với cơ sở dữ liệu MongoDB.
const mongoose = require("mongoose");
// Khai báo thư viện Mongoose - bộ thư viện trung gian
//  giúp thao tác với MongoDB dễ dàng hơn qua các Schema/Model.
const connectDB = async () => { //Đây là một hàm bất đồng bộ.
//  Việc kết nối tới server database cần thời gian chờ, nên phải dùng async/await
  try {// Thử kết nối tới MongoDB bằng URI từ biến môi trường
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    // Nếu kết nối thành công, in ra thông báo với tên host
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {//
    // Nếu có lỗi xảy ra trong quá trình kết nối, in lỗi ra console
    // Sau đó thoát ứng dụng với mã lỗi 1 (thường dùng để chỉ lỗi không mong muốn)
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);// Thoát ứng dụng với mã lỗi 1 để báo lỗi nghiêm trọng
  }
};

module.exports = connectDB;
