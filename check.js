const mongoose = require('mongoose');
require('dotenv').config();

const Plan = require('./src/models/Plan');
const Document = require('./src/models/Document');

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("Connected to MongoDB.");
    const plans = await Plan.find().sort({ createdAt: -1 }).limit(3).populate('documentId');
    for (let p of plans) {
        console.log(`Plan ID: ${p._id}, Title: ${p.title}`);
        if (p.documentId) {
            console.log(`  -> Document ID: ${p.documentId._id}`);
            console.log(`  -> fileUrl: ${p.documentId.fileUrl}`);
            console.log(`  -> content length: ${p.documentId.content ? p.documentId.content.length : 0}`);
        } else {
            console.log(`  -> No documentId populated!`);
        }
    }
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
