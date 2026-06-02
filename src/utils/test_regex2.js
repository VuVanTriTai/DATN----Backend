const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

async function test() {
    const docPath = path.join(path.dirname(require.resolve('mammoth')), '../test-data/tables.docx');
    const result = await mammoth.convertToHtml({ path: docPath });
    let html = result.value;

    console.log('--- ORIGINAL HTML ---');
    console.log(html);

    html = html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (match, tableContent) => {
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

    console.log('--- EXTRACTED MD ---');
    console.log(html);
}
test();
