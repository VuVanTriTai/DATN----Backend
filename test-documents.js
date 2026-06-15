require('dns').setServers(['1.1.1.1', '8.8.8.8']);
require("dotenv").config();
const mongoose = require("mongoose");
const Document = require("./src/models/Document");

mongoose.connect(process.env.MONGODB_URI, { family: 4 })
.then(async () => {
  console.log("Connected to DB, querying documents...");
  const docs = await Document.find({}).sort({ createdAt: -1 }).limit(10);
  docs.forEach(doc => {
    console.log(`ID: ${doc._id} | Title: ${doc.title} | FileUrl: ${doc.fileUrl} | CreatedAt: ${doc.createdAt}`);
  });
  mongoose.connection.close();
})
.catch(err => {
  console.error("Error:", err);
});
