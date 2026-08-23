// ============================================================
// ไฟล์นี้ต้องวางไว้ที่ตำแหน่ง  /api/generate-image.js  ในโปรเจกต์
// (อยู่ในโฟลเดอร์เดียวกับ /api/chat.js)
//
// เรียกใช้ได้ที่ URL: https://<โดเมนเว็บ>/api/generate-image
//
// หน้าที่ของไฟล์นี้ คือทำตัวเป็น "คนกลาง" ระหว่างเว็บของเรา กับ Google Gemini API
// - รับ prompt (คำอธิบายภาพ) จากหน้าเว็บ
// - แนบ GEMINI_API_KEY (เก็บลับไว้ใน Environment Variable ของ Vercel เหมือน GROQ_API_KEY)
// - ส่งไปให้โมเดล gemini-2.5-flash-image สร้างภาพ แล้วส่งภาพ (base64) กลับมาให้หน้าเว็บ
//
// วิธีได้ GEMINI_API_KEY (ฟรี ไม่ต้องผูกบัตรเครดิต):
// 1. เข้า https://aistudio.google.com/apikey (ต้อง login ด้วยบัญชี Google)
// 2. กด "Create API key" เลือกโปรเจกต์ (หรือสร้างใหม่) แล้วคัดลอก key ที่ได้
// 3. ไปตั้งค่าใน Vercel: โปรเจกต์ ETC-AI > Settings > Environment Variables
//    ตั้งชื่อ GEMINI_API_KEY แล้ววาง key ที่คัดลอกมา > Save > Redeploy โปรเจกต์
// ============================================================

export const config = {
  runtime: "edge",
};

const MODEL_NAME = "gemini-2.5-flash-image";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { prompt } = await req.json();

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return new Response(JSON.stringify({ error: "ไม่พบคำอธิบายภาพ (prompt)" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // process.env.GEMINI_API_KEY ถูกดึงมาจาก Environment Variable ที่ตั้งไว้ใน Vercel
        // (ไม่มีทางโผล่ในโค้ดฝั่ง frontend เด็ดขาด เหมือนกับ GROQ_API_KEY)
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
        },
        // ===== เพิ่มใหม่: ตั้งค่าตัวกรองความปลอดภัยแบบเข้มไว้ชัดเจน (นอกเหนือจากตัวกรองพื้นฐานของ Gemini เอง)
        // BLOCK_LOW_AND_ABOVE คือระดับเข้มที่สุด ป้องกันไว้ก่อนเพราะเว็บนี้เป็นเว็บสาธารณะ ใครก็เข้าถึงได้ =====
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" },
        ],
      }),
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      return new Response(JSON.stringify({ error: "Gemini API error", detail: errorText }), {
        status: geminiResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await geminiResponse.json();
    const candidate = data.candidates && data.candidates[0];

    // ===== เพิ่มใหม่: ถ้า Gemini บล็อกคำขอนี้เพราะเนื้อหาไม่เหมาะสม จะไม่มีรูปกลับมา ให้แจ้งฝั่งหน้าเว็บรู้ว่า "โดนบล็อก"
    // เพื่อให้หน้าเว็บแสดงข้อความสุภาพแทน error ดิบๆ =====
    if (!candidate || candidate.finishReason === "IMAGE_SAFETY" || candidate.finishReason === "SAFETY") {
      return new Response(JSON.stringify({ error: "เนื้อหาถูกบล็อกโดยระบบความปลอดภัย", blocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // หารูปภาพ (inlineData) จากส่วน parts ของคำตอบ Gemini
    const imagePart = (candidate.content?.parts || []).find(p => p.inlineData);

    if (!imagePart) {
      return new Response(JSON.stringify({ error: "ไม่พบรูปภาพในคำตอบจาก Gemini", blocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { mimeType, data: base64Data } = imagePart.inlineData;

    return new Response(JSON.stringify({ image: `data:${mimeType};base64,${base64Data}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
