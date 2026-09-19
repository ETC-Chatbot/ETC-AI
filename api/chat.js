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

// ===== แก้ไข (กลับไปใช้ qwen เป็นหลัก): ลองใช้ groq/compound เป็นโมเดลหลักแล้วพบว่า "เข้าใจบทบาท ETC" แย่กว่า
// qwen มาก — ตีความคำสั่งใน system prompt ตรงตัวเกินไป (เช่น ทักทาย "สวัสดี" กลับด้วยการอธิบายว่า "คำตอบของคำ
// ทักทายคือการตอบกลับด้วยคำว่าสวัสดี" แทนที่จะทักทายตรงๆ, หรือสรุป system prompt ของตัวเองออกมาให้ผู้ใช้เห็น)
// เปลี่ยนกลับมาใช้ qwen3.8-27b เป็นค่าเริ่มต้นสำหรับคำถามทั่วไป (เข้าใจบทบาทเป็นธรรมชาติกว่ามาก) แล้วสลับไปใช้
// groq/compound เฉพาะข้อความที่น่าจะต้องการข้อมูลปัจจุบัน/ล่าสุดจากเว็บจริงๆ เท่านั้น (ดูฟังก์ชัน needsWebSearch
// ด้านล่าง) แบบนี้ได้ทั้ง 2 อย่าง: บทสนทนาทั่วไปเป็นธรรมชาติแบบเดิม + ยังตอบคำถามที่ต้องข้อมูลสดได้อยู่ =====
const DEFAULT_MODEL = "qwen/qwen3.8-27b";
// ===== แก้ไข (บั๊กร้ายแรงอีกจุด): groq/compound รองรับค้นเว็บได้หลายครั้งต่อคำถามเดียว ถ้าเจอคำถามที่ต้อง
// ค้นหลายรอบ อาจใช้เวลานานกว่าจะเริ่มส่งคำตอบตัวแรกกลับมา ซึ่ง Vercel Edge Functions กำหนดไว้ว่าเซิร์ฟเวอร์ต้อง
// เริ่มส่งข้อมูลกลับภายใน 25 วินาที ไม่งั้นจะถูกตัดการเชื่อมต่อทิ้งเงียบๆ (ไม่มี error ให้เห็นด้วย เหมือนค้างไปเลย)
// เปลี่ยนมาใช้ groq/compound-mini แทน ซึ่งจำกัดไว้แค่ 1 ครั้งต่อคำถาม (เร็วกว่าเฉลี่ย 3 เท่า) ลดความเสี่ยงเรื่องนี้
// ได้เยอะ แลกกับกรณีคำถามที่ต้องค้นเว็บหลายแหล่งจริงๆ อาจได้คำตอบละเอียดน้อยกว่า groq/compound เล็กน้อย =====
// ===== แก้ไข: กลับมาใช้ groq/compound ตัวเต็ม (ค้นเว็บได้หลายรอบ ละเอียด/มีโอกาสเจอข้อมูลเฉพาะทางมากกว่า
// compound-mini ที่จำกัดแค่ 1 ครั้ง) เพื่อเพิ่มโอกาสหาข้อมูลเฉพาะเจาะจง (เช่นชื่อบุคคลในหน่วยงานท้องถิ่น) เจอ
// มากขึ้น แลกกับความเสี่ยงเรื่องใช้เวลานานที่เคยทำให้ค้างไปก่อนหน้านี้ — คราวนี้ป้องกันด้วยระบบยกเลิกอัตโนมัติ
// ฝั่ง frontend แทน (ดูใน index.html ฟังก์ชัน handleSendAction) ถ้าค้นนานเกินไปจะแจ้งเตือนแทนที่จะค้างเงียบๆ =====
const SEARCH_MODEL = "groq/compound";

// ===== เพิ่มใหม่: ตรวจแบบคร่าวๆ (keyword matching) ว่าข้อความน่าจะต้องใช้ข้อมูลปัจจุบัน/ล่าสุดจากเว็บไหม
// เป็นการเดาแบบหยาบๆ ไม่แม่น 100% เหมือนกับระบบตรวจจับคำสั่งสร้างภาพที่ปรับจูนกันมาหลายรอบ ถ้าเจอคำขอที่ควร
// ค้นเว็บแต่ไม่ถูกจับได้ (หรือจับผิดทั้งที่ไม่จำเป็น) เพิ่ม/ลดคำในลิสต์นี้ได้เรื่อยๆ ตามที่เจอจริง =====
function needsWebSearch(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const keywords = [
    "ล่าสุด", "ตอนนี้", "ปัจจุบัน", "เดี๋ยวนี้", "ขณะนี้", "วันนี้",
    "ข่าว", "ราคา", "หุ้น", "อัตราแลกเปลี่ยน", "พยากรณ์อากาศ", "อากาศวันนี้",
    "ใครเป็น", "ใครดำรงตำแหน่ง", "นายกฯ", "นายกรัฐมนตรี", "ประธานาธิบดี", "ผอ.", "ผู้อำนวยการ",
    "เกิดอะไรขึ้น", "มีอะไรใหม่", "อัปเดต",
    "latest", "current", "right now", "news", "today's",
  ];
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

export default async function handler(req) {
  // ===== เพิ่มใหม่: ตัวบอกเวอร์ชันโค้ด เช็คได้จาก Vercel > โปรเจกต์ > แท็บ Logs ว่าไฟล์นี้ถูก deploy จริงหรือยัง =====
  console.log("[chat build: 2026-09-18-compound-full-with-frontend-timeout]");
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

    // ===== เพิ่มใหม่: หาข้อความล่าสุดของผู้ใช้ (ไม่ใช่ของ ETC) มาเช็คว่าต้องใช้ groq/compound (ค้นเว็บได้)
    // หรือใช้ qwen3.8-27b ตามปกติ (content อาจเป็น string ธรรมดา หรือเป็น array ถ้ามีการแนบรูปด้วย) =====
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const lastUserText = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : (Array.isArray(lastUserMsg?.content) ? (lastUserMsg.content.find(c => c.type === "text")?.text || "") : "");
    const useSearchModel = needsWebSearch(lastUserText);
    const selectedModel = useSearchModel ? SEARCH_MODEL : DEFAULT_MODEL;

    // ===== เพิ่มใหม่: สร้าง request body แยกกันตามโมเดลที่เลือก เพราะพารามิเตอร์ปรับแต่งของ qwen (reasoning_format,
    // reasoning_effort, presence_penalty, top_p) ใช้ไม่ได้กับ groq/compound (ไม่มีในเอกสาร อาจถูกปฏิเสธคำขอได้) =====
    const requestBody = {
      model: selectedModel,
      messages: messages,
      temperature: temperature ?? 0.7,
      stream: true, // เปิด streaming เพื่อให้ข้อความค่อยๆ พิมพ์ออกมา
    };
    if (useSearchModel) {
      // groq/compound มีโควตา TPM สูงกว่า qwen มาก (70,000 เทียบกับ 1,000 token/นาที) เผื่อพื้นที่คำตอบยาวได้มากขึ้น
      requestBody.max_tokens = 1500;
    } else {
      // qwen3.8-27b เป็นโมเดลที่ "คิดก่อนตอบ" (reasoning model) ถ้าไม่ตั้งค่านี้ ขั้นตอนความคิด (thinking
      // process) จะปนมาในคำตอบด้วย ตั้งเป็น "hidden" เพื่อให้ Groq ซ่อนส่วนคิด ส่งกลับมาแค่คำตอบสุดท้าย
      requestBody.reasoning_format = "hidden";
      // ผูกกับสวิตช์ "ระบบคิดละเอียด" ในหน้าตั้งค่า ถ้าเปิดไว้ (deepThinking===true) ให้เปิดโหมดคิดลึก
      requestBody.reasoning_effort = deepThinking === true ? "default" : "none";
      // ค่าที่ผู้ผลิตโมเดล (Qwen) แนะนำเฉพาะตอนปิดโหมดคิดลึก (non-thinking mode) presence_penalty=1.5 ช่วยกัน
      // โมเดล "พูดวนซ้ำคำเดิมไม่จบ" top_p=0.8 ช่วยให้คำตอบสมเหตุสมผล ไม่กระโดดหัวข้อ
      requestBody.presence_penalty = 1.5;
      requestBody.top_p = 0.8;
      requestBody.max_tokens = 900;
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
      body: JSON.stringify(requestBody),
    });

    // ===== เพิ่มใหม่: log ว่าคำขอนี้เลือกใช้โมเดลไหน ช่วยเช็คได้ว่าระบบตรวจจับ needsWebSearch() ทำงานตรงตามที่
    // ควรจะเป็นไหม (เช่นเจอคำถามที่ควรค้นเว็บแต่ดันไม่ถูกจับ หรือจับผิดทั้งที่ไม่จำเป็นต้องค้น) =====
    console.log("[chat] เลือกโมเดล:", selectedModel, "| ข้อความ:", JSON.stringify(lastUserText).slice(0, 100));

    // ถ้า Groq ตอบ error (เช่น key ผิด, โมเดลถูกยุบ) ส่ง error กลับไปตรงๆ
    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      return new Response(errorText, {
        status: groqResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ส่ง stream ที่ได้จาก Groq ต่อไปยังหน้าเว็บทันที ไม่ต้องรอให้ตอบครบ
    // ===== แก้ไข (บั๊กร้ายแรง): เคยเพิ่ม .tee() ไว้แยกสตรีมไปเช็คเบื้องหลังว่ามีการค้นเว็บจริงไหม แต่พบว่าทำให้
    // คำขอที่ใช้เวลานาน (เช่นตอนค้นเว็บผ่าน groq/compound) ค้างไม่ตอบเลย คาดว่าเกิดจาก Edge Runtime หยุดการรัน
    // ส่วน background (ที่ไม่ได้ await) กลางคันหลังฟังก์ชัน return ไปแล้ว ซึ่งไปเบรกสตรีมหลักที่ส่งให้ผู้ใช้ด้วย
    // (เพราะ .tee() ต้องให้ทั้ง 2 ฝั่งอ่านตามทัน) เอาออกแล้ว ให้ความเสถียรของการตอบมาก่อนฟีเจอร์ log เสริม —
    // อยากรู้ว่าคำขอไหนใช้โมเดลไหน ดูจาก log "[chat] เลือกโมเดล:" ด้านบนได้อยู่แล้ว เพียงพอสำหรับ debug =====
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
