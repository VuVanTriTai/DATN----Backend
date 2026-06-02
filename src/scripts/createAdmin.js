/**
 * Script tạo tài khoản Admin mặc định.
 * Chạy: node src/scripts/createAdmin.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const mongoose = require("mongoose");
const User = require("../models/User");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@aibuddy.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@123456";
const ADMIN_NAME = "Super Admin";

async function createAdmin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Đã kết nối MongoDB");

    const existing = await User.findOne({ email: ADMIN_EMAIL });
    if (existing) {
      // Nếu đã tồn tại, đảm bảo role là admin
      if (!existing.role.includes("admin")) {
        existing.role = ["admin"];
        await existing.save();
        console.log(`⚡ Đã nâng cấp tài khoản ${ADMIN_EMAIL} lên Admin!`);
      } else {
        console.log(`ℹ️  Tài khoản admin ${ADMIN_EMAIL} đã tồn tại.`);
      }
      return;
    }

    // Tạo mới — để pre-save hook tự hash
    await User.create({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,   // pre-save hook sẽ tự hash
      fullName: ADMIN_NAME,
      role: ["admin"],
    });

    console.log("🎉 Tạo tài khoản Admin thành công!");
    console.log(`   📧 Email   : ${ADMIN_EMAIL}`);
    console.log(`   🔑 Password: ${ADMIN_PASSWORD}`);
    console.log("   ⚠️  Hãy đổi mật khẩu sau khi đăng nhập lần đầu!");
  } catch (error) {
    console.error("❌ Lỗi khi tạo admin:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Đã ngắt kết nối MongoDB");
    process.exit(0);
  }
}

createAdmin();
