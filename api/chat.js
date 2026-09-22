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

// ===== แก้ไข (สถาปัตยกรรมใหม่): เดิมสลับไปใช้ groq/compound เวลาต้องค้นเว็บ แต่เจอปัญหาเรื่องบุคลิกไม่เป็น ETC
// (ตีความคำสั่งตรงตัวเกินไป) และการค้นเว็บของ compound ครอบคลุมน้อยกว่า Google (หาข้อมูลเฉพาะทางไม่เจอ) เปลี่ยน
// มาใช้วิธีนี้แทน: ค้นเว็บเองผ่าน Serper API (ผลลัพธ์เหมือน Google จริงๆ) แล้วเอาผลที่ได้ยัดเป็น "ข้อมูลอ้างอิง"
// ให้ qwen อ่านแล้วสรุปตอบ วิธีนี้ได้ทั้ง 2 อย่าง: ค้นเว็บครอบคลุมกว่าเดิมมาก + บุคลิก ETC เป็นธรรมชาติเหมือนเดิม
// ทุกครั้ง (เพราะ qwen เป็นคนเขียนคำตอบสุดท้ายเสมอ ไม่มีการสลับโมเดลอีกต่อไป) =====
const DEFAULT_MODEL = "qwen/qwen3.8-27b";

// ===== เพิ่มใหม่: ตรวจแบบคร่าวๆ (keyword matching) ว่าข้อความน่าจะต้องใช้ข้อมูลปัจจุบัน/ล่าสุดจากเว็บไหม
// เป็นการเดาแบบหยาบๆ ไม่แม่น 100% ถ้าเจอคำขอที่ควรค้นเว็บแต่ไม่ถูกจับได้ (หรือจับผิดทั้งที่ไม่จำเป็น)
// เพิ่ม/ลดคำในลิสต์นี้ได้เรื่อยๆ ตามที่เจอจริง =====
function needsWebSearch(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const keywords = [
    "ล่าสุด", "ตอนนี้", "ปัจจุบัน", "เดี๋ยวนี้", "ขณะนี้", "วันนี้",
    "ข่าว", "ราคา", "หุ้น", "อัตราแลกเปลี่ยน", "พยากรณ์อากาศ", "อากาศวันนี้",
    "ใครเป็น", "ใครดำรงตำแหน่ง", "นายกฯ", "นายกรัฐมนตรี", "ประธานาธิบดี", "ผอ.", "ผู้อำนวยการ", "หัวหน้าแผนก",
    "เกิดอะไรขึ้น", "มีอะไรใหม่", "อัปเดต",
    "latest", "current", "right now", "news", "today's",
  ];
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

// ===== เพิ่มใหม่: ยิงคำค้นไปที่ Serper API (คืนผลลัพธ์แบบเดียวกับหน้า Google Search จริงๆ) แล้วสรุปผลลัพธ์
// อันดับต้นๆ ออกมาเป็นข้อความสั้นๆ ให้ qwen เอาไปใช้ตอบ ถ้าไม่มี SERPER_API_KEY ตั้งไว้ หรือเรียกไม่สำเร็จไม่ว่า
// เหตุผลอะไรก็ตาม คืนค่า null กลับไปเงียบๆ (โค้ดฝั่งเรียกจะจัดการต่อเองว่าให้ตอบแบบไม่มีข้อมูลค้นเว็บ) =====
async function searchWithSerper(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      // gl/hl ตั้งเป็นไทย ช่วยให้ผลลัพธ์ที่เกี่ยวข้องกับประเทศไทยขึ้นมาแม่นกว่า
      body: JSON.stringify({ q: query, gl: "th", hl: "th" }),
    });
    if (!res.ok) {
      console.log("[chat] Serper เรียกไม่สำเร็จ status:", res.status);
      return null;
    }
    const data = await res.json();
    const organic = (data.organic || []).slice(0, 5);
    if (organic.length === 0) return null;
    return organic
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || ""}\n(ที่มา: ${r.link})`)
      .join("\n\n");
  } catch (err) {
    console.log("[chat] Serper search error:", err.message);
    return null;
  }
}

// ===== เพิ่มใหม่: Tavily เป็นตัวค้นเว็บสำรอง ใช้ตอน Serper เรียกไม่สำเร็จ (เช่น โควตาฟรีแบบให้ครั้งเดียว 2,500
// ครั้งของ Serper หมดลง) ข้อดีของ Tavily คือโควตาฟรีรีเซตใหม่ทุกเดือน ไม่ใช่ให้ครั้งเดียวเหมือน Serper จึงใช้ต่อ
// ได้เรื่อยๆ แบบไม่มีค่าใช้จ่ายในระยะยาว (แลกกับคุณภาพผลลัพธ์ที่อาจไม่ใกล้เคียง Google เท่า Serper) =====
async function searchWithTavily(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 5 }),
    });
    if (!res.ok) {
      console.log("[chat] Tavily เรียกไม่สำเร็จ status:", res.status);
      return null;
    }
    const data = await res.json();
    const results = (data.results || []).slice(0, 5);
    if (results.length === 0) return null;
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n${r.content || ""}\n(ที่มา: ${r.url})`)
      .join("\n\n");
  } catch (err) {
    console.log("[chat] Tavily search error:", err.message);
    return null;
  }
}

// ===== เพิ่มใหม่: ลอง Serper ก่อนเสมอ (คุณภาพผลลัพธ์ดีกว่า เหมือน Google จริงๆ) ถ้าเรียกไม่สำเร็จไม่ว่าเหตุผล
// อะไรก็ตาม (รวมถึงโควตาหมด) ค่อยลอง Tavily ต่อเป็นตัวสำรอง ถ้าทั้งคู่ไม่สำเร็จหรือไม่ได้ตั้ง key ไว้เลย คืนค่า
// null ให้โค้ดที่เรียกใช้จัดการต่อเอง (qwen จะตอบแบบไม่มีข้อมูลค้นเว็บ) =====
async function searchWeb(query) {
  const serperResult = await searchWithSerper(query);
  if (serperResult) return { text: serperResult, provider: "Serper" };
  const tavilyResult = await searchWithTavily(query);
  if (tavilyResult) return { text: tavilyResult, provider: "Tavily" };
  return null;
}

export default async function handler(req) {
  // ===== เพิ่มใหม่: ตัวบอกเวอร์ชันโค้ด เช็คได้จาก Vercel > โปรเจกต์ > แท็บ Logs ว่าไฟล์นี้ถูก deploy จริงหรือยัง =====
  console.log("[chat build: 2026-09-21-tavily-fallback]");
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

    // ===== แก้ไข: หาข้อความล่าสุดของผู้ใช้ (ไม่ใช่ของ ETC) มาเช็คว่าต้องค้นเว็บผ่าน Serper ก่อนตอบไหม
    // (content อาจเป็น string ธรรมดา หรือเป็น array ถ้ามีการแนบรูปด้วย) =====
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const lastUserText = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : (Array.isArray(lastUserMsg?.content) ? (lastUserMsg.content.find(c => c.type === "text")?.text || "") : "");

    // ===== เพิ่มใหม่: ถ้าเข้าข่ายต้องการข้อมูลปัจจุบัน ค้นเว็บผ่าน Serper ก่อน แล้วยัดผลลัพธ์เป็นข้อความระบบ
    // (system message) แทรกไว้ก่อนข้อความล่าสุดของผู้ใช้ ให้ qwen อ่านแล้วใช้ประกอบการตอบ ถ้าค้นไม่สำเร็จ/ไม่มี
    // key ตั้งไว้ ก็แค่ไม่แทรกอะไรเพิ่ม (qwen จะตอบตามความรู้เดิม หรือบอกตรงๆ ว่าไม่มีข้อมูลเหมือนเดิม) =====
    let finalMessages = messages;
    // ===== แก้ไข: ใช้ searchWeb() แทนการเรียก searchWithSerper() ตรงๆ (ลอง Serper ก่อน ถ้าไม่สำเร็จลอง Tavily
    // ต่อเป็นตัวสำรองอัตโนมัติ กันกรณีโควตาฟรีของ Serper หมดแล้วเว็บใช้งานค้นเว็บต่อไม่ได้เลย) =====
    if (needsWebSearch(lastUserText)) {
      const searchResult = await searchWeb(lastUserText);
      console.log("[chat] ค้นเว็บ:", searchResult ? `พบผลลัพธ์ (${searchResult.provider})` : "ไม่พบ/ไม่ได้ค้น");
      if (searchResult) {
        const searchContextMsg = {
          role: "system",
          content: `[ผลการค้นเว็บล่าสุดสำหรับคำถามล่าสุดของผู้ใช้ ใช้ข้อมูลนี้ประกอบการตอบตามความเหมาะสม ถ้าไม่พบคำตอบที่ต้องการในนี้ ให้บอกตามตรงว่าไม่พบข้อมูล ห้ามเดาเอาเอง]\n\n${searchResult.text}`,
        };
        finalMessages = [...messages.slice(0, -1), searchContextMsg, messages[messages.length - 1]];
      }
    }

    // ===== เพิ่มใหม่: สร้าง request body สำหรับ qwen (โมเดลเดียวที่ใช้ตอนนี้ ไม่มีการสลับโมเดลอีกต่อไป) =====
    const requestBody = {
      model: DEFAULT_MODEL,
      messages: finalMessages,
      temperature: temperature ?? 0.7,
      stream: true, // เปิด streaming เพื่อให้ข้อความค่อยๆ พิมพ์ออกมา
      // qwen3.8-27b เป็นโมเดลที่ "คิดก่อนตอบ" (reasoning model) ถ้าไม่ตั้งค่านี้ ขั้นตอนความคิด (thinking
      // process) จะปนมาในคำตอบด้วย ตั้งเป็น "hidden" เพื่อให้ Groq ซ่อนส่วนคิด ส่งกลับมาแค่คำตอบสุดท้าย
      reasoning_format: "hidden",
      // ผูกกับสวิตช์ "ระบบคิดละเอียด" ในหน้าตั้งค่า ถ้าเปิดไว้ (deepThinking===true) ให้เปิดโหมดคิดลึก
      reasoning_effort: deepThinking === true ? "default" : "none",
      // ค่าที่ผู้ผลิตโมเดล (Qwen) แนะนำเฉพาะตอนปิดโหมดคิดลึก (non-thinking mode) presence_penalty=1.5 ช่วยกัน
      // โมเดล "พูดวนซ้ำคำเดิมไม่จบ" top_p=0.8 ช่วยให้คำตอบสมเหตุสมผล ไม่กระโดดหัวข้อ
      presence_penalty: 1.5,
      top_p: 0.8,
      max_tokens: 900,
    };

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

    // ===== แก้ไข: log ว่าคำถามนี้ค้นเว็บไหม (เลือกโมเดลตอนนี้คงที่เป็น qwen เสมอแล้ว ไม่ต้อง log ตัวโมเดลอีก) =====
    console.log("[chat] ข้อความ:", JSON.stringify(lastUserText).slice(0, 100));

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
