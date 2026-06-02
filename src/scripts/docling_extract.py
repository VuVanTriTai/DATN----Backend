#!/usr/bin/env python3
"""
docling_extract.py
------------------
Đọc file tài liệu (PDF, DOCX, PPTX, ...) bằng docling và xuất JSON ra stdout.
Usage:
    python docling_extract.py <file_path>
Output JSON:
    { "success": true,  "text": "...", "method": "docling" }
    { "success": false, "error": "..." }
"""

import sys
import json
import os
import re
import html
import unicodedata

# Force UTF-8 output trên Windows (tránh lỗi charmap codec)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
else:
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')


# ─────────────────────────────────────────────
# SQL KEYWORD RECOVERY
# Một số slide có chữ cái đầu bị bold riêng → docling render sai
# Ví dụ: "**EGIN TRAN**" → "BEGIN TRAN"
# ─────────────────────────────────────────────
SQL_KEYWORDS = [
    # T-SQL keywords thường bị mất chữ đầu trong slide
    ("EGIN", "BEGIN"),
    ("AVE TRAN", "SAVE TRAN"),
    ("OMMIT", "COMMIT"),
    ("OLLBACK", "ROLLBACK"),
    ("ELECT", "SELECT"),
    ("NSERT", "INSERT"),
    ("PDATE", "UPDATE"),
    ("ELETE", "DELETE"),
    ("REATE", "CREATE"),
    ("ROP ", "DROP "),
    ("LTER", "ALTER"),
    ("HERE ", "WHERE "),
    ("ROM ", "FROM "),
    ("ROUP BY", "GROUP BY"),
    ("RDER BY", "ORDER BY"),
    ("AVING", "HAVING"),
    ("OIN", "JOIN"),
    ("NNER", "INNER"),
    ("UTER", "OUTER"),
    ("IGHT", "RIGHT"),
    ("EFT", "LEFT"),
    ("ECLARE", "DECLARE"),
    ("XEC", "EXEC"),
    ("RINT", "PRINT"),
    ("F ", "IF "),
    ("LSE", "ELSE"),
    ("HILE", "WHILE"),
    ("ETURN", "RETURN"),
    ("OT NULL", "NOT NULL"),
    ("RIMARY", "PRIMARY"),
    ("OREIGN", "FOREIGN"),
]


def recover_sql_keywords(text: str) -> str:
    """
    Phục hồi SQL keyword bị mất chữ cái đầu.
    Chỉ áp dụng khi pattern xuất hiện ở đầu từ (sau space, |, ** hoặc đầu dòng).
    """
    for broken, correct in SQL_KEYWORDS:
        # Pattern: sau **, |, dấu cách hoặc đầu dòng
        pattern = r'(?<=[*| \n\t])' + re.escape(broken) + r'(?=[ \t\n\r*|{(\[]|$)'
        text = re.sub(pattern, correct, text)
    return text


# ─────────────────────────────────────────────
# POST-PROCESS DOCLING MARKDOWN OUTPUT
# ─────────────────────────────────────────────
def postprocess_markdown(text: str) -> str:
    """
    Làm sạch và chuẩn hóa markdown từ docling.
    Xử lý theo thứ tự:
    1. Unicode normalization (NFC)
    2. HTML entity decode (&#124; trước, sau đó unescape chung)
    3. Escape markdown cleanup (\_  \* \[ \])
    4. SQL keyword recovery
    5. Line joining fix (dính dòng trong bảng)
    6. Whitespace cleanup
    """

    # 1. Unicode normalization → NFC (chuẩn hóa ký tự tổ hợp tiếng Việt)
    text = unicodedata.normalize('NFC', text)

    # 2a. &#124; (pipe) trong table cells → thay bằng ⏐ (vertical bar U+23D0)
    #     để không phá vỡ cấu trúc markdown table, rồi sau decode trả lại
    #     Thực ra dùng " | " sẽ phá bảng → dùng Unicode PIPE EQUIVALENT
    #     Sau này cleanText.js sẽ handle
    text = text.replace('&#124;', '\u007c')   # decode thẳng → | nhưng trong context table sẽ OK

    # 2b. Decode HTML entities (&amp; &lt; &gt; &nbsp; &quot; &#39; ...)
    text = html.unescape(text)

    # 3. Cleanup docling markdown escapes
    #    docling hay escape ký tự _ * [ ] trong nội dung text
    text = re.sub(r'\\(_)', r'\1', text)       # \_ → _
    text = re.sub(r'\\\*', '*', text)          # \* → *
    text = re.sub(r'\\\[', '[', text)          # \[ → [
    text = re.sub(r'\\\]', ']', text)          # \] → ]
    text = re.sub(r'\\#', '#', text)           # \# → #

    # 4. SQL keyword recovery (chữ đầu bị mất do slide formatting)
    text = recover_sql_keywords(text)

    # 5. Fix dính dòng trong table cell (nhiều câu trên 1 dòng không có xuống hàng)
    #    Trường hợp: "...thực hiện. Câu lệnh..." → "...thực hiện.\nCâu lệnh..."
    #    Chỉ áp dụng cho text thường, không áp dụng bên trong **bold** code
    def fix_sentence_joins(line: str) -> str:
        if line.startswith('|'):
            # Trong table cell: không thêm newline vì sẽ phá table
            return line
        # Ngoài table: thêm newline sau dấu câu nếu chữ tiếp theo là HOA
        line = re.sub(r'([.!?]) ([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠ])', r'\1\n\2', line)
        return line

    lines = text.split('\n')
    lines = [fix_sentence_joins(l) for l in lines]
    text = '\n'.join(lines)

    # 6. Loại bỏ dòng chỉ chứa số thứ tự lẻ (artifact từ slide như "2.\n" "1.\n")
    text = re.sub(r'^\d+\.\s*$', '', text, flags=re.MULTILINE)

    # 7. Giảm blank lines liên tiếp
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No file path provided"}))
        sys.exit(1)

    file_path = sys.argv[1]

    if not os.path.exists(file_path):
        print(json.dumps({"success": False, "error": f"File not found: {file_path}"}))
        sys.exit(1)

    try:
        from docling.document_converter import DocumentConverter

        converter = DocumentConverter()
        result = converter.convert(file_path)

        # Xuất toàn bộ nội dung dạng Markdown
        markdown_text = result.document.export_to_markdown()

        if not markdown_text or len(markdown_text.strip()) < 10:
            print(json.dumps({"success": False, "error": "Docling could not extract text from the document"}))
            sys.exit(1)

        # Post-process: decode HTML, fix encoding, SQL keywords, line joins
        cleaned_text = postprocess_markdown(markdown_text)

        # Lấy số trang an toàn
        num_pages = None
        try:
            raw = getattr(result.document, 'num_pages', None)
            if callable(raw):
                num_pages = raw()
            elif isinstance(raw, int):
                num_pages = raw
        except Exception:
            pass

        print(json.dumps({
            "success": True,
            "text": cleaned_text,
            "method": "docling",
            "pages": num_pages,
        }, ensure_ascii=False))

    except ImportError:
        print(json.dumps({"success": False, "error": "docling is not installed. Run: pip install docling"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
