// ============================================================
// ไฟล์นี้ต้องวางไว้ที่ตำแหน่ง  /api/generate-image.js  ในโปรเจกต์
// (อยู่ในโฟลเดอร์เดียวกับ /api/chat.js)
//
// เรียกใช้ได้ที่ URL: https://<โดเมนเว็บ>/api/generate-image
//
// หน้าที่ของไฟล์นี้ คือทำตัวเป็น "คนกลาง" ระหว่างเว็บของเรา กับ Cloudflare Workers AI
// - รับ prompt (คำอธิบายภาพ) จากหน้าเว็บ
// - เช็คคำต้องห้ามเบื้องต้นก่อนส่งไป (ตัวกรองของเราเอง เพราะ Workers AI ไม่มีตัวกรองในตัวแบบ Gemini)
// - แนบ CF_API_TOKEN (เก็บลับไว้ใน Environment Variable ของ Vercel เหมือน GROQ_API_KEY)
// - ส่งไปให้โมเดล flux-1-schnell สร้างภาพ แล้วส่งภาพ (base64) กลับมาให้หน้าเว็บ
//
// ===== แก้ไข (สำคัญ): เดิมใช้ Gemini API แต่โควตาฟรีของโมเดลสร้างภาพเจอบั๊กจาก Google เอง
// (ขึ้น quota limit: 0 แม้ยังไม่ได้ผูกบัตร) จึงเปลี่ยนมาใช้ Cloudflare Workers AI แทน
// เพราะฟรีจริง ไม่ต้องผูกบัตร แต่ต้องเขียนตัวกรองคำต้องห้ามเองเพิ่ม เพราะโมเดลนี้ไม่มีตัวกรองในตัว =====
//
// วิธีได้ CF_ACCOUNT_ID และ CF_API_TOKEN (ฟรี ไม่ต้องผูกบัตรเครดิต):
// 1. สมัครบัญชีที่ https://dash.cloudflare.com/sign-up
// 2. เข้าเมนู "Workers & Pages" จะเห็น Account ID อยู่ด้านขวาของหน้า คัดลอกเก็บไว้
// 3. คลิกรูปโปรไฟล์ > My Profile > API Tokens > Create Token > เลือกเท็มเพลต "Workers AI (Beta)"
//    กด Continue to summary > Create Token แล้วคัดลอกเก็บไว้ (เห็นครั้งเดียว)
// 4. ไปตั้งค่าใน Vercel: โปรเจกต์ ETC-AI > Settings > Environment Variables
//    ตั้งชื่อ CF_ACCOUNT_ID และ CF_API_TOKEN ตามลำดับ > Save > Redeploy โปรเจกต์
// ============================================================

export const config = {
  runtime: "edge",
};

const MODEL_NAME = "@cf/black-forest-labs/flux-1-schnell";

// ===== เพิ่มใหม่: ตัวกรองคำต้องห้ามเบื้องต้น (ทำหน้าที่แทนตัวกรองในตัวของ Gemini ที่ไม่มีใน Workers AI)
// เช็คทั้งภาษาไทยและอังกฤษ ครอบคลุมหมวดเนื้อหาทางเพศ ความรุนแรง และเนื้อหาที่เกี่ยวกับผู้เยาว์ในทางไม่เหมาะสม
// รายการนี้เป็นแค่ชั้นป้องกันแรก ไม่ใช่ตัวกรองสมบูรณ์แบบ 100% แต่ช่วยตัดคำขอที่ชัดเจนว่าไม่เหมาะสมออกไปก่อน =====
const BLOCKED_KEYWORDS = [
  "porn", "nude", "naked", "sex", "explicit", "nsfw", "erotic", "hentai",
  "โป๊", "เปลือย", "เซ็กส์", "ลามก", "ข่มขืน", "อนาจาร",
  "gore", "kill", "murder", "corpse", "suicide", "self-harm",
  "ฆ่า", "ศพ", "ฆ่าตัวตาย", "ทำร้ายตัวเอง",
  "child", "kid", "minor", "loli", "toddler",
  "เด็ก", "เยาวชน", "นักเรียน",
];

function containsBlockedContent(text) {
  const lower = text.toLowerCase();
  return BLOCKED_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

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

    // ===== เพิ่มใหม่: เช็คคำต้องห้ามก่อนส่งไปสร้างภาพเลย ตัดปัญหาตั้งแต่ต้นทาง =====
    if (containsBlockedContent(prompt)) {
      return new Response(JSON.stringify({ error: "เนื้อหาไม่เหมาะสม", blocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const accountId = process.env.CF_ACCOUNT_ID;
    const apiToken = process.env.CF_API_TOKEN;
    const CF_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL_NAME}`;

    const cfResponse = await fetch(CF_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // process.env.CF_API_TOKEN ถูกดึงมาจาก Environment Variable ที่ตั้งไว้ใน Vercel
        "Authorization": `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        prompt: prompt,
        // จำนวนรอบประมวลผลของ flux-1-schnell ยิ่งมากยิ่งคมชัดแต่ช้าลง ค่า 4 คือค่าที่โมเดลนี้ออกแบบมาให้เร็วและดีพอ
        num_steps: 4,
      }),
    });

    if (!cfResponse.ok) {
      const errorText = await cfResponse.text();
      return new Response(JSON.stringify({ error: "Cloudflare Workers AI error", detail: errorText }), {
        status: cfResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await cfResponse.json();

    // ===== เพิ่มใหม่: ตรวจสอบว่า Cloudflare แจ้ง error กลับมาในตัว response เอง (success: false) หรือไม่ =====
    if (!data.success || !data.result || !data.result.image) {
      return new Response(JSON.stringify({ error: "ไม่พบรูปภาพในคำตอบจาก Cloudflare", detail: JSON.stringify(data.errors || data) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // flux-1-schnell ส่งภาพกลับมาเป็น base64 ล้วนๆ (ไม่มี prefix data:) ต้องเติม prefix เองก่อนส่งให้หน้าเว็บ
    return new Response(JSON.stringify({ image: `data:image/jpeg;base64,${data.result.image}` }), {
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
