// utils/queryRewrite.js
//
"use strict";

const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const rewriteQuery = async (question) => {
  try {
    if (!question || question.length < 3) return question;

    const prompt = `
Rewrite the user question to be clear and specific.

RULES:
- Keep original meaning
- Add missing context if vague
- Output ONLY the rewritten question

QUESTION:
${question}
`;

    const res = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0,
      messages: [
        { role: "system", content: "You improve search queries." },
        { role: "user", content: prompt }
      ]
    });

    const rewritten = res.choices?.[0]?.message?.content?.trim();

    console.log("🔄 Rewrite:", question, "→", rewritten);

    return rewritten || question;

  } catch (err) {
    console.warn("⚠️ Rewrite fail");
    return question;
  }
};

module.exports = { rewriteQuery };