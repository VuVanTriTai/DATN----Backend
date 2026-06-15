require('dns').setServers(['1.1.1.1', '8.8.8.8']);
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = mongoose.model("User", new mongoose.Schema({
  email: String,
  role: String
}));

mongoose.connect(process.env.MONGODB_URI, { family: 4 })
.then(async () => {
  const learner = await User.findOne({ role: 'learner' });
  if (!learner) {
    console.error("No learner found");
  } else {
    console.log("Found learner:", learner.email, "ID:", learner._id);
    const token = jwt.sign(
      { id: learner._id, role: learner.role },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "1h" }
    );
    console.log("JWT_TOKEN:", token);
  }
  mongoose.connection.close();
})
.catch(err => {
  console.error(err);
});
