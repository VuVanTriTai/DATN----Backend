// utils/test_regex.js
// Đây là file test regex để trích xuất nội dung bảng từ HTML, chuyển đổi sang định dạng Markdown để hiển thị trong chatbot. Chúng ta sẽ sử dụng regex để tìm các thẻ <table>, sau đó trích xuất các hàng và cột, loại bỏ thẻ HTML còn lại và định dạng lại thành Markdown.
const html = '<table><tbody><tr><td><p>A</p></td><td><p>B</p></td></tr></tbody></table>';
const replaced = html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (match, tableContent) => {
    let mdTable = '\n\n[BẢNG DỮ LIỆU / SO SÁNH]\n';
    let rows = tableContent.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (let row of rows) {
      let cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
      let mdRow = '|';
      for (let cell of cells) {
        let cellContent = cell.replace(/<t[dh][^>]*>|<\/t[dh]>/gi, '');
        cellContent = cellContent.replace(/<[^>]+>/g, ' ').replace(/\n|\r/g, ' ').replace(/\s+/g, ' ').trim();
        mdRow += ' ' + cellContent + ' |';
      }
      mdTable += mdRow + '\n';
    }
    return mdTable + '\n';
});
console.log(replaced);
