"use strict";

// Test the full chain: splitGluedLatinWords (now fixed) → fixOcrGluedWords → cleanHeadingOcr

const { fixOcrGluedWords } = require('./src/utils/cleanText');

let pass = 0, fail = 0;
const check = (label, got, expected) => {
  const ok = got === expected;
  console.log(ok ? '[OK]' : '[FAIL]', label);
  if (!ok) console.log('  got:     ', JSON.stringify(got), '\n  expected:', JSON.stringify(expected));
  ok ? pass++ : fail++;
};

console.log("=== OCR Gluing Fix (via fixOcrGluedWords) ===");

// Case 1: ALLCAPS + TitleCase → Pattern 3 in splitGluedLatinWords
check('SQLKiểu → SQL Kiểu',
  fixOcrGluedWords('SQLKiểu').trim(),
  'SQL Kiểu'
);

// Case 2: TitleCase word (9 chars) + lowercase word (5 chars)
check('Proceduretrong → Procedure trong',
  fixOcrGluedWords('Proceduretrong').trim(),
  'Procedure trong'
);

// Case 3: Mixed string as heading
check('Full heading: Stored Proceduretrong CSDL',
  fixOcrGluedWords('Stored Proceduretrong CSDL').trim(),
  'Stored Procedure trong CSDL'
);

// Case 4: Transact-SQLKiểu
check('Transact-SQLKiểu Nhóm câu Lệnh',
  fixOcrGluedWords('Transact-SQLKiểu Nhóm câu Lệnh').trim(),
  'Transact-SQL Kiểu Nhóm câu Lệnh'
);

// Case 5: No-op (already clean)
check('No-op: Stored Procedure (already clean)',
  fixOcrGluedWords('Stored Procedure').trim(),
  'Stored Procedure'
);

// Case 6: No-op Vietnamese only
check('No-op: Vietnamese only',
  fixOcrGluedWords('1.1 Các tùy chọn lập trình').trim(),
  '1.1 Các tùy chọn lập trình'
);

// Case 7: tạothông báo lỗi (Vietnamese gluing — VI_COMMON_GLUED)
check('tạothông → tạo thông (via VI_COMMON_GLUED)',
  fixOcrGluedWords('tạothông báo lỗi').trim(),
  'tạo thông báo lỗi'
);

console.log(`\nPassed: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
