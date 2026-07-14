// ============================================================
// ไฟล์นี้ต้องวางไว้ที่ตำแหน่ง  /api/chat.js  ในโปรเจกต์
// (ให้อยู่ระดับเดียวกับโฟลเดอร์ img/ และไฟล์ index.html)
//
// Vercel จะเห็นไฟล์ใน /api/ อัตโนมัติแล้วแปลงให้เป็น endpoint
// เรียกใช้ได้ที่ URL: https://<โดเมนเว็บ>/api/chat
//
// หน้าที่ของไฟล์นี้ คือทำตัวเป็น "คนกลาง" ระหว่างเว็บของเรา กับ Groq
// - รับข้อความจากหน้าเว็บ (ที่ไม่มี API key ติดไปด้วย)
// - แนบ GROQ_API_KEY (เก็บลับไว้ในตั้งค่า Vercel ไม่โผล่ในโค้ด)
// - ส่งต่อไป Groq แล้วส่ง stream คำตอบกลับมาให้หน้าเว็บ
// ============================================================

// ใช้ Edge Runtime เพราะรองรับการส่งข้อมูลแบบ streaming ได้ลื่นกว่า
export const config = {
  runtime: "edge",
};

// ตายตัวไว้ฝั่งเซิร์ฟเวอร์ ป้องกันไม่ให้ใครยิง request มาสั่งโมเดลอื่นที่แพงกว่า
const MODEL_NAME = "qwen/qwen3.6-27b";

export default async function handler(req) {
  // อนุญาตแค่ POST เท่านั้น (กันคนเปิด URL ตรงๆ ผ่าน browser)
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // ดึง messages (ประวัติแชท) และ temperature ที่หน้าเว็บส่งมา
    const { messages, temperature } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "ไม่พบข้อมูล messages" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ยิง request ไปที่ Groq โดยใส่ API key ที่ซ่อนไว้ใน Environment Variable
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // process.env.GROQ_API_KEY จะถูกดึงมาจากที่ตั้งค่าไว้ใน Vercel Dashboard
        // (ไม่มีทางโผล่ในโค้ดฝั่ง frontend เด็ดขาด)
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: messages,
        temperature: temperature ?? 0.7,
        stream: true, // เปิด streaming เพื่อให้ข้อความค่อยๆ พิมพ์ออกมา
        // ===== เพิ่มใหม่: qwen3.6-27b เป็นโมเดลที่ "คิดก่อนตอบ" (reasoning model) =====
        // ถ้าไม่ตั้งค่านี้ ขั้นตอนความคิดทั้งหมด (thinking process) จะปนมาในคำตอบด้วย
        // ตั้งเป็น "hidden" เพื่อให้ Groq ซ่อนส่วนคิด ส่งกลับมาแค่คำตอบสุดท้ายที่สมบูรณ์
        reasoning_format: "hidden",
        // ===== เพิ่มใหม่: ปิดโหมด "คิดลึก" (thinking mode) ไปเลย เพราะ ETC เป็นบอทสนทนาทั่วไป ไม่ใช่บอทแก้โจทย์คณิตศาสตร์/โค้ดซับซ้อน
        // ถ้าเปิดโหมดคิดลึกไว้ (ค่าเริ่มต้น) โมเดลจะใช้เวลาคิดนานมากก่อนเริ่มตอบ แม้จะซ่อนไม่ให้เห็นก็ตาม ทำให้รู้สึกว่าตอบช้า
        // ตั้งเป็น "none" จะได้คำตอบเร็วขึ้นมาก เหมาะกับแชทพูดคุยทั่วไป
        reasoning_effort: "none",
      }),
    });

    // ถ้า Groq ตอบ error (เช่น key ผิด, โมเดลถูกยุบ) ส่ง error กลับไปตรงๆ
    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      return new Response(errorText, {
        status: groqResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ส่ง stream ที่ได้จาก Groq ต่อไปยังหน้าเว็บทันที ไม่ต้องรอให้ตอบครบ
    return new Response(groqResponse.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
