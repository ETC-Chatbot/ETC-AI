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
    // ดึง messages (ประวัติแชท), temperature, และค่าสวิตช์ "ระบบคิดละเอียด" ที่หน้าเว็บส่งมา
    const { messages, temperature, deepThinking } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "ไม่พบข้อมูล messages" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ===== เพิ่มใหม่: qwen3.6-27b รองรับการดูภาพได้ในตัว (multimodal) โดยไม่ต้องเปลี่ยนโมเดล
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
        // ===== เพิ่มใหม่: qwen3.6-27b เป็นโมเดลที่ "คิดก่อนตอบ" (reasoning model) =====
        // ถ้าไม่ตั้งค่านี้ ขั้นตอนความคิดทั้งหมด (thinking process) จะปนมาในคำตอบด้วย
        // ตั้งเป็น "hidden" เพื่อให้ Groq ซ่อนส่วนคิด ส่งกลับมาแค่คำตอบสุดท้ายที่สมบูรณ์
        reasoning_format: "hidden",
        // ===== แก้ไข: ผูกกับสวิตช์ "ระบบคิดละเอียด" ในหน้าตั้งค่าจริงๆ แทนที่จะปิดตายตัวเสมอ
        // ถ้าผู้ใช้เปิดสวิตช์ไว้ (deepThinking===true) ให้เปิดโหมดคิดลึกของโมเดล (ตอบช้าลงแต่วิเคราะห์ละเอียดขึ้น)
        // ถ้าไม่เปิด (ค่าเริ่มต้น) ให้ปิดโหมดคิดลึกไว้เหมือนเดิม เพื่อความเร็วในการสนทนาทั่วไป =====
        reasoning_effort: deepThinking === true ? "default" : "none",
        // ===== เพิ่มใหม่: ค่าที่ผู้ผลิตโมเดล (Qwen) แนะนำเฉพาะตอนปิดโหมดคิดลึก (non-thinking mode)
        // presence_penalty=1.5 ช่วยป้องกันปัญหาโมเดล "พูดวนซ้ำคำเดิมไม่จบ" (เช่นกรณีท่องชื่อซ้ำๆไม่หยุด)
        // top_p=0.8 ช่วยให้คำตอบสมเหตุสมผล ไม่กระโดดหัวข้อ =====
        presence_penalty: 1.5,
        top_p: 0.8,
        // ===== เพิ่มใหม่: กำหนดเพดานความยาวคำตอบให้กว้างพอ กันคำตอบถูกตัดสั้นเกินไปก่อนพูดจบประเด็น =====
        max_tokens: 1536,
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
