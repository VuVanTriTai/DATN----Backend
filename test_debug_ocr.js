"use strict";

// Debug: what's in those strings?
const s1 = 'Transact-SQLKiểu';
const s2 = 'Proceduretrong';
const s3 = 'SQLStored';

console.log('=== Char analysis: SQLKiểu ===');
[...s1.slice(-6)].forEach((c) => {
  const cp = c.codePointAt(0);
  console.log(` '${c}'  U+${cp.toString(16).padStart(4,'0')}  in Việt range: ${cp >= 0x00C0 && cp <= 0x1EF9}`);
});

console.log('\n=== Pattern test: [A-Z]{2,}+Việt ===');
const p1 = /([A-Z]{2,})([\u00C0-\u1EF9])/;
console.log('Test:', p1.test(s1));
console.log('Match:', s1.match(p1));

console.log('\n=== Char analysis: Proceduretrong ===');
[...'etrong'].forEach((c) => {
  const cp = c.codePointAt(0);
  console.log(` '${c}'  U+${cp.toString(16).padStart(4,'0')}  in \\u00E0-\\u1EF9: ${cp >= 0x00E0 && cp <= 0x1EF9}`);
});

// "trong" in Vietnamese — all chars are plain ASCII: t,r,o,n,g
// This means pattern [A-Z][a-z]{2,} + [\u00E0-\u1EF9] won't match because 't' is ASCII!
console.log('\n"trong" starts with ASCII t:', 't'.codePointAt(0), '— NOT a Vietnamese char');
console.log('Pattern [A-Z][a-z]+ + Viet would need next char to be Viet accented');

// The real issue: "Proceduretrong" — 'P'[A-Z] + 'rocedure'[a-z]+ then 't'[a-z NOT Viet]
// So pattern 2 "([A-Z][a-z]{2,})([\u00E0-\u1EF9])" needs 't' to be a Việt char -> FAIL
// Need to detect Latin word boundary differently

console.log('\n=== Correct approach: word boundary detection ===');
// "Proceduretrong" = TitleCase Latin word + lowercase Latin
// Can detect: [A-Z][a-z]+ followed by [a-z] when it forms a new word
// Better: split at camelCase-like boundary even for all-lowercase after TitleCase
const fixes = [
  // Detect TitleCase (Aa+) followed immediately by lowercase letter that starts next word
  // This won't work because we can't tell "Procedure" from "Procedure" ending
  // Unless we match full-word: /([A-Z][a-z]+)([a-z]{2,})/
  // "Procedure" + "trong" => 'e' + 't' = lowercase + lowercase => no camelCase signal

  // REAL fix: unicode word boundary approach
  // If we normalize the string and see two consecutive "words" glued:
  // Proceduretrong → we need a dictionary or ML approach
  // OR: specific pattern for known gluing types
  
  // For "SQLKiểu": L (uppercase) + K (uppercase starting Việt) — the K is encoded differently
];

// Let's check if 'K' in 'Kiểu' is regular ASCII K or has special encoding
const kieuStr = 'Kiểu';
console.log('\n"Kiểu" chars:');
[...kieuStr].forEach(c => {
  const cp = c.codePointAt(0);
  console.log(` '${c}'  U+${cp.toString(16).padStart(4,'0')}`);
});

// So 'K' is U+004B = regular ASCII K
// 'iể' = 'i' U+0069 (ASCII) + 'ể' U+1EC3 (Viet)  OR precomposed 'iể'
// Let's check NFC vs NFD
const nfc = 'Kiểu'.normalize('NFC');
const nfd = 'Kiểu'.normalize('NFD');
console.log('NFC len:', nfc.length, [...nfc].map(c => c.codePointAt(0).toString(16)));
console.log('NFD len:', nfd.length, [...nfd].map(c => c.codePointAt(0).toString(16)));

// Now the real question: in "SQLKiểu", what follows L?
const glued = 'SQLKiểu';
console.log('\n"SQLKiểu" chars:');
[...glued].forEach(c => {
  const cp = c.codePointAt(0);
  console.log(` '${c}'  U+${cp.toString(16).padStart(4,'0')}`);
});
console.log('\nPattern [A-Z]{2,} matches SQL, then next char K = U+004B = ASCII K, NOT Viet!');
console.log('So [A-Z]{2,}+[\\u00C0-\\u1EF9] does NOT match SQLKiểu because K is ASCII');
