const axios = require('axios');
const fs = require('fs');
const path = require('path');

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5OTY4OWQxZGQ5N2I0YmY1ODUyYzExNSIsImlhdCI6MTc4MTQ2Mzc3OCwiZXhwIjoxNzgxNDY3Mzc4fQ.oGsQVfL90OLivEHzNPAfYxl1W8UGDpWw5O1GyMSEovY";
const filePath = path.join(__dirname, "test.txt");

if (!fs.existsSync(filePath)) {
  console.error("File does not exist:", filePath);
  process.exit(1);
}

// Since form-data package might not be installed, we can build raw multipart body or require it
// Let's check if form-data package exists by requiring it. Multer relies on form-data or we can construct it.
try {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  axios.post("http://localhost:5000/api/file/extract", form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${token}`
    }
  })
  .then(res => {
    console.log("SUCCESS:");
    console.log(JSON.stringify(res.data, null, 2));
  })
  .catch(err => {
    console.error("ERROR:", err.response ? err.response.data : err.message);
  });
} catch (e) {
  console.error("form-data require error:", e.message);
}
