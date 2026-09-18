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
// ===== แก้ไข: เปลี่ยนจาก qwen/qwen3.8-27b เป็น groq/compound เพื่อให้ ETC ค้นหาข้อมูลปัจจุบันจากเว็บได้เองอัตโนมัติ
// (ข่าวล่าสุด ราคาปัจจุบัน ใครดำรงตำแหน่งอะไรตอนนี้ ฯลฯ) โดยไม่ต้องเขียนโค้ดเชื่อม Search API เพิ่มเอง ตัวระบบจะ
// ตัดสินใจเองว่าคำถามไหนต้องค้นเว็บก่อนตอบ คำถามทั่วไปที่ไม่ต้องค้นก็จะตอบเร็วตามปกติ
// ===== ข้อควรรู้: โควตาฟรีต่อวันของ groq/compound น้อยกว่า qwen (250 ครั้ง/วัน เทียบกับ 1,000 ครั้ง/วัน) และยัง
// ไม่ได้ทดสอบว่ารองรับการส่งรูปภาพให้วิเคราะห์ (ฟีเจอร์ 📷) เหมือน qwen หรือไม่ ควรทดสอบทั้ง 2 เรื่องนี้หลัง deploy
const MODEL_NAME = "groq/compound";

export default async function handler(req) {
  // ===== เพิ่มใหม่: ตัวบอกเวอร์ชันโค้ด เช็คได้จาก Vercel > โปรเจกต์ > แท็บ Logs ว่าไฟล์นี้ถูก deploy จริงหรือยัง =====
  console.log("[chat build: 2026-09-18-use-groq-compound]");
  // อนุญาตแค่ POST เท่านั้น (กันคนเปิด URL ตรงๆ ผ่าน browser)
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // ดึง messages (ประวัติแชท), temperature, และค่าสวิตช์ "ระบบคิดละเอียด" ที่หน้าเว็บส่งมา
    const { messages, temperature, deepThinking } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "ไม่พบข้อมูล messages" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ===== เพิ่มใหม่: qwen3.8-27b รองรับการดูภาพได้ในตัว (multimodal) โดยไม่ต้องเปลี่ยนโมเดล
    // หน้าเว็บจะส่ง content เป็น array [{type:"text",...}, {type:"image_url",...}] มาแทน string ธรรมดา เมื่อผู้ใช้แนบรูป
    // Groq จำกัดขนาดรูปไว้ที่ 20MB ต่อคำขอ เผื่อไว้ที่ 18MB กันพลาดเรื่อง overhead ของ base64 encoding =====
    const payloadSize = JSON.stringify(messages).length;
    if (payloadSize > 18 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "ไฟล์รูปภาพใหญ่เกินไปค่ะ กรุณาเลือกรูปที่เล็กกว่านี้" }), {
        status: 413,
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
        // ===== แก้ไข: เอาพารามิเตอร์ reasoning_format / reasoning_effort / presence_penalty / top_p ออก
        // เพราะเป็นค่าที่ปรับไว้เฉพาะสำหรับโมเดลตระกูล Qwen เอกสารของ groq/compound ไม่ได้พูดถึงพารามิเตอร์
        // เหล่านี้เลย ส่งไปอาจไม่มีผล หรือแย่กว่านั้นคือ Groq อาจปฏิเสธคำขอเพราะพารามิเตอร์ไม่ตรงกับระบบนี้
        // ===== หมายเหตุ: สวิตช์ "ระบบคิดละเอียด" (deepThinking) ในหน้าตั้งค่าตอนนี้ไม่มีผลกับ groq/compound
        // แล้ว (เดิมเคยสั่งงานผ่าน reasoning_effort) เพราะ groq/compound ไม่มีพารามิเตอร์นี้ให้ปรับ ตัวระบบเอง
        // จะตัดสินใจเรื่องการค้นเว็บ/ใช้เครื่องมือให้อัตโนมัติอยู่แล้วโดยไม่ต้องสั่ง =====
        // ===== แก้ไข: เพิ่ม max_tokens จาก 900 เป็น 1500 เพราะ groq/compound มีโควตา TPM (70,000 token/นาที)
        // สูงกว่า qwen เดิมมาก (1,000 token/นาที) จึงเผื่อพื้นที่คำตอบยาวขึ้นได้โดยไม่เสี่ยงโดน rate limit ง่ายๆ
        // เหมือนก่อน =====
        max_tokens: 1500,
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
