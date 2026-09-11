// ============================================================
// ไฟล์นี้ต้องวางไว้ที่ตำแหน่ง  /api/generate-image.js  ในโปรเจกต์
// (อยู่ในโฟลเดอร์เดียวกับ /api/chat.js)
//
// เรียกใช้ได้ที่ URL: https://<โดเมนเว็บ>/api/generate-image
//
// หน้าที่ของไฟล์นี้ คือทำตัวเป็น "คนกลาง" ระหว่างเว็บของเรา กับ Cloudflare Workers AI
// ขั้นตอนการทำงาน:
// 1. รับ prompt (คำอธิบายภาพ ภาษาไทยหรืออังกฤษก็ได้) จากหน้าเว็บ
// 2. เช็คคำต้องห้ามเบื้องต้นก่อน (ตัวกรองของเราเอง เพราะ Workers AI ไม่มีตัวกรองในตัวแบบ Gemini)
// 3. ===== เพิ่มใหม่: ให้ Groq (โมเดลแชทเดิมที่ใช้อยู่แล้ว) ช่วย "แปล+เติมรายละเอียด" คำขอเป็นภาษาอังกฤษ
//    ก่อนส่งไปวาดภาพ เพราะ Flux เข้าใจ prompt ภาษาอังกฤษได้แม่นยำกว่าภาษาไทยมาก
//    (ปัญหาที่เจอก่อนหน้านี้คือส่ง "สร้างรูปประเทศไทย" ตรงๆ แล้วภาพที่ได้ไม่เกี่ยวกับไทยเลย) =====
// 4. ส่ง prompt ที่แปลแล้วไปให้โมเดล flux-1-schnell สร้างภาพ แล้วส่งภาพ (base64) กลับมาให้หน้าเว็บ
//
// วิธีได้ CF_ACCOUNT_ID และ CF_API_TOKEN (ฟรี ไม่ต้องผูกบัตรเครดิต):
// 1. สมัครบัญชีที่ https://dash.cloudflare.com/sign-up
// 2. เข้าเมนู "Workers & Pages" จะเห็น Account ID อยู่ด้านขวาของหน้า คัดลอกเก็บไว้
// 3. คลิกรูปโปรไฟล์ > My Profile > API Tokens > Create Token > เลือกเท็มเพลต "Workers AI"
//    กด Continue to summary > Create Token แล้วคัดลอกเก็บไว้ (เห็นครั้งเดียว)
// 4. ไปตั้งค่าใน Vercel: โปรเจกต์ ETC-AI > Settings > Environment Variables
//    ตั้งชื่อ CF_ACCOUNT_ID และ CF_API_TOKEN ตามลำดับ > Save > Redeploy โปรเจกต์
// (ใช้ GROQ_API_KEY ตัวเดิมที่มีอยู่แล้วในโปรเจกต์ ไม่ต้องตั้งค่าเพิ่ม)
// ============================================================

export const config = {
  runtime: "edge",
};

const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
// ===== แก้ไข: เดิมใช้ qwen/qwen3.6-27b ตัวเดียวกับที่แชทใช้ ทำให้เวลาแชทกันเยอะๆ โควตาต่อนาที (rate limit)
// ของ Groq ถูกใช้ร่วมกันหมด พอคุยเยอะก็ทำให้สร้างภาพไม่ได้ไปด้วย (และกลับกัน) เปลี่ยนมาใช้ openai/gpt-oss-20b
// แทน ซึ่งเป็นคนละโมเดล จึงมีโควตาแยกต่างหากจากแชทโดยอัตโนมัติ (ไม่ต้องตั้งค่าอะไรเพิ่ม) แถมเร็วกว่าด้วย
// (~1000 token/วินาที เทียบกับ qwen ที่ ~500 token/วินาที) เหมาะกับงานเขียน prompt สั้นๆ แบบนี้พอดี =====
const IMAGE_PROMPT_MODEL = "openai/gpt-oss-20b";

// ===== เพิ่มใหม่: ตัวกรองคำต้องห้ามเบื้องต้น (ทำหน้าที่แทนตัวกรองในตัวของ Gemini ที่ไม่มีใน Workers AI)
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
  const matched = BLOCKED_KEYWORDS.find(kw => lower.includes(kw.toLowerCase()));
  // ===== เพิ่มใหม่: log คำที่ไปชนตัวกรองไว้ฝั่งเซิร์ฟเวอร์เท่านั้น (ดูได้ที่ Vercel > โปรเจกต์ > แท็บ Logs)
  // ไม่โชว์ให้ผู้ใช้เห็นเด็ดขาด ช่วยให้เวลาเจอ false positive (บล็อกทั้งที่คำขอไม่มีปัญหาจริง) รู้สาเหตุแน่ชัด
  // ว่าคำไหนไปชน แทนที่จะต้องเดา (บ่อยครั้งคำที่ชนไม่ได้มาจากคำที่ผู้ใช้พิมพ์เอง แต่มาจาก prompt ที่ Groq
  // แปล/เติมรายละเอียดให้เป็นภาษาอังกฤษก่อนส่งไปวาดภาพ) =====
  if (matched) {
    console.log("[generate-image] blocked by keyword:", JSON.stringify(matched), "| text:", text);
  }
  return !!matched;
}

// ===== เพิ่มใหม่: ให้ Groq ช่วยแปล+เติมรายละเอียด prompt ให้เป็นภาษาอังกฤษที่ชัดเจน ก่อนส่งไปวาดภาพ
// ถ้าเรียก Groq ไม่สำเร็จด้วยเหตุผลใดก็ตาม ให้ fallback กลับไปใช้ prompt เดิมที่ผู้ใช้พิมพ์มา (กันระบบล่มทั้งหมด) =====
async function expandPromptWithGroq(rawPrompt) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: IMAGE_PROMPT_MODEL,
        messages: [
          {
            role: "system",
            // ===== แก้ไข (บั๊กสำคัญเรื่องโควตาหมดเร็ว): เดิมใส่คำอธิบายภาษาไทยยาวๆ (ที่ตั้งใจเขียนไว้อธิบาย
            // โค้ดให้คนอ่าน) ปนอยู่ข้างในสตริง prompt จริงที่ส่งให้ Groq ทุกครั้งโดยไม่ตั้งใจ ทำให้แต่ละคำขอกิน
            // token เยอะเกินจำเป็นมาก (ภาษาไทยกิน token ต่อคำมากกว่าอังกฤษหลายเท่า) พอโควตา TPM ของ tier ฟรีมีแค่
            // 8,000 token/นาที เลยหมดเร็วผิดปกติ (แค่ 1-2 ภาพก็ใกล้ชนแล้ว) ย้ายคำอธิบายทั้งหมดออกมาเป็นคอมเมนต์
            // ของโค้ดแทน (แบบนี้) และทำให้ prompt จริงที่ส่งไปกระชับที่สุด ใช้แต่ภาษาอังกฤษเท่านั้น =====
            //
            // สรุปสิ่งที่ prompt ข้างล่างนี้สั่งโมเดลไว้:
            // 1. เขียน prompt ภาพให้กระชับแต่ชัดเจน จากคำขอภาษาไทย/อังกฤษของผู้ใช้
            // 2. ห้ามมีตัวหนังสือ/ป้ายในภาพ (กันโมเดลวาดภาพสุ่มใส่ตัวอักษรมั่วๆ)
            // 3. ถ้าขอภาพบุคคลจริงที่มีตัวตน (นักการเมือง ดารา คนดัง) ให้ตอบ REAL_PERSON_REQUEST แทนการเขียน
            //    prompt เพราะโมเดลวาดภาพไม่รู้จักหน้าตาคนจริง และป้องกันความเสี่ยงเรื่องภาพปลอม/deepfake
            // 4. ถ้าคำขอไม่ระบุชุด ให้ใส่ชุดสุภาพเสมอ ห้ามชุดว่ายน้ำ/เสื้อผ้าเผยเนื้อหนังเกินควร
            content: "You are a prompt writer for a text-to-image AI model. The user gives a short request, possibly in Thai. Rewrite it into ONE vivid English prompt describing subject, setting, colors, and style concretely. If it mentions a place or culture (e.g. Thailand), include recognizable visual elements. If the request names a real, identifiable public figure (politician, celebrity, athlete, CEO, or similar — by full name, nickname, or title like 'the current PM'), reply with exactly: REAL_PERSON_REQUEST and nothing else. Fictional characters and unnamed generic people don't count; write a normal prompt for those. If clothing isn't specified, use modest everyday clothing — never swimwear, bikinis, or revealing outfits unless explicitly requested. Always end the prompt with: 'photorealistic photograph, no text, no writing, no letters, no captions, no watermark, no infographic elements'. Reply with ONLY the prompt (or REAL_PERSON_REQUEST), no quotes, no explanation.",
          },
          { role: "user", content: rawPrompt },
        ],
        temperature: 0.7,
        max_tokens: 200,
        stream: false,
        // ===== แก้ไข (บั๊กสำคัญที่เจอจาก Vercel Logs): qwen3.6-27b เป็น reasoning model ที่ "คิดออกเสียง"
        // ก่อนตอบเสมอ (ส่งข้อความ <think>...</think> มาก่อนคำตอบจริง) ถ้าไม่ปิดไว้ ส่วนคิดจะโดน max_tokens:200
        // ตัดกลางคันก่อนถึงคำตอบจริง ทำให้ได้ prompt เป็นแค่เศษข้อความ "กำลังคิด" ที่มักมีคำอย่าง explicit/
        // inappropriate ปนอยู่ (เพราะโมเดลกำลังวิเคราะห์ความเหมาะสมของคำขอ) แล้วไปโดนตัวกรองคำต้องห้ามของเรา
        // เองเข้าเต็มๆ (เกิดกับแทบทุก prompt แม้แต่คำขอธรรมดาๆ เพราะไม่เกี่ยวกับเนื้อหาจริงเลย) chat.js ตั้งค่า
        // นี้ไว้ถูกต้องอยู่แล้ว แต่ไฟล์นี้ลืมตั้ง จึงเป็นสาเหตุที่แท้จริงของปัญหา "สร้างภาพอะไรก็โดนบล็อก" =====
        // ===== แก้ไข (บั๊กสำคัญรอบ 2 ที่เจอจาก Vercel Logs): ตอนสลับมาใช้ openai/gpt-oss-20b แทน qwen แล้ว
        // ยังใช้พารามิเตอร์ reasoning_format: "hidden" ค้างไว้ แต่ตระกูล GPT-OSS ของ Groq ไม่ใช้ชื่อพารามิเตอร์นี้
        // (เอกสาร Groq ระบุว่า GPT-OSS ใช้ "include_reasoning: false" แทน) พอส่งชื่อพารามิเตอร์ผิดตระกูลโมเดลไป
        // Groq ปฏิเสธคำขอ (res.ok เป็น false) โค้ดเลย fallback กลับไปใช้ prompt ภาษาไทยดิบๆ แบบเงียบๆ (เห็นได้จาก
        // log ที่ raw กับ enhanced เหมือนกันเป๊ะทุกครั้ง) ทำให้ Flux ได้รับข้อความไทยที่มันไม่เข้าใจ แล้ววาดภาพมั่วออกมา
        // ไม่ตรงกับคำขอเลย (นี่คือสาเหตุจริงของปัญหา "ภาพไม่ตรง" ที่เจอมาตลอดหลังเปลี่ยนโมเดล) =====
        include_reasoning: false,
      }),
    });

    // ===== แก้ไข (บั๊กสำคัญที่เจอจาก Vercel Logs): เดิมพอเรียก Groq ไม่สำเร็จ (เช่นโดน rate limit ตอนมีคน
    // ทดสอบถี่ๆ ติดกัน) จะเงียบๆ ใช้ prompt ภาษาไทยดิบส่งไปให้ Flux ตรงๆ ซึ่ง Flux เข้าใจอังกฤษเป็นหลัก พอเจอ
    // ข้อความไทยที่ไม่เข้าใจ เลยวาดภาพมั่วๆ ออกมาไม่ตรงกับคำขอเลย (ผู้ใช้เห็นแค่ภาพผิด ไม่รู้สาเหตุ) เปลี่ยนมาคืนค่า
    // พิเศษ "EXPANSION_FAILED" แทน ให้ handler ด้านล่างแจ้งผู้ใช้ตรงๆ ว่าระบบมีปัญหาชั่วคราว ให้ลองใหม่ ดีกว่าเดินหน้า
    // สร้างภาพที่รู้อยู่แล้วว่าจะไม่ตรงแน่ๆ =====
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.log("[generate-image] Groq prompt expansion ล้มเหลว status:", res.status, "| body:", errText);
      return "EXPANSION_FAILED";
    }

    const data = await res.json();
    const expanded = data.choices?.[0]?.message?.content?.trim();
    if (!expanded) return "EXPANSION_FAILED";

    // ===== เพิ่มใหม่: ถ้า Groq ตอบว่าเป็นคำขอภาพบุคคลจริง ส่งค่าพิเศษนี้กลับไปตรงๆ ให้ handler จัดการต่อ
    // (ไม่ต้องเช็คคำปฏิเสธด้านล่าง เพราะนี่ไม่ใช่การปฏิเสธของ Groq เอง แต่เป็นสัญญาณที่เราสั่งให้ Groq ส่งมาเอง) =====
    if (expanded === "REAL_PERSON_REQUEST") return "REAL_PERSON_REQUEST";

    // ===== เพิ่มใหม่: บางครั้งโมเดลที่ใช้แปล prompt (Groq) ตีความคำสั่งธรรมดาผิดว่าอาจไม่เหมาะสม แล้วตอบกลับ
    // มาเป็น "ข้อความปฏิเสธ" แทนที่จะเป็น prompt ภาพจริงๆ (เช่น "I cannot create this as it may be considered
    // inappropriate/explicit") พอเอาข้อความปฏิเสธนั้นไปเช็คกับ containsBlockedContent() ของเราเอง ก็ไปชนคำอย่าง
    // "explicit"/"inappropriate" เข้าโดยบังเอิญ ทำให้ภาพที่ไม่มีปัญหาอะไรเลยโดนบล็อกผิดๆ ซ้อนอีกชั้น (เช่นกรณี
    // "ลิงกินกล้วย" ที่ไม่มีอะไรผิดปกติแต่โดนบล็อก) เช็คคร่าวๆ ว่าคำตอบที่ได้ "หน้าตาเหมือนการปฏิเสธ" ไหม
    // ถ้าใช่ ให้ทิ้งไปแล้วใช้ prompt ต้นฉบับแทน (ดีกว่าปล่อยให้ข้อความปฏิเสธหลุดเข้าไปในระบบ) =====
    const refusalSignals = ["cannot create", "can't create", "cannot generate", "can't generate", "i'm sorry", "i am sorry", "unable to", "inappropriate", "not able to", "i cannot", "i can't"];
    const looksLikeRefusal = refusalSignals.some(sig => expanded.toLowerCase().includes(sig));
    if (looksLikeRefusal) {
      console.log("[generate-image] Groq expansion ดูเหมือนข้อความปฏิเสธ ใช้ prompt เดิมแทน:", expanded);
      return rawPrompt;
    }

    return expanded;
  } catch (err) {
    // ===== แก้ไข: log error ไว้ด้วย (เดิมไม่มี เลยไม่รู้เลยว่า exception คืออะไรถ้าเกิดขึ้น) และคืนค่า
    // EXPANSION_FAILED เหมือนกรณี !res.ok ด้านบน แทนที่จะใช้ prompt ดิบ =====
    console.log("[generate-image] Groq prompt expansion error:", err.message);
    return "EXPANSION_FAILED";
  }
}

export default async function handler(req) {
  // ===== เพิ่มใหม่: ตัวบอกเวอร์ชันโค้ด เช็คได้จาก Vercel > โปรเจกต์ > แท็บ Logs ว่าไฟล์นี้ถูก deploy จริงหรือยัง =====
  console.log("[generate-image build: 2026-09-11-shrink-prompt-token-usage]");
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

    // เช็คคำต้องห้ามจาก prompt ต้นฉบับก่อนเลย
    if (containsBlockedContent(prompt)) {
      return new Response(JSON.stringify({ error: "เนื้อหาไม่เหมาะสม", blocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ===== เพิ่มใหม่: แปล+เติมรายละเอียด prompt เป็นภาษาอังกฤษก่อนส่งไปวาด =====
    const enhancedPrompt = await expandPromptWithGroq(prompt);

    // ===== เพิ่มใหม่: ถ้าแปล prompt ไม่สำเร็จ (เช่นโดน rate limit ของ Groq ตอนมีคนใช้งานถี่ๆ) ไม่ส่งข้อความไทย
    // ดิบๆ ไปให้ Flux ต่อ (จะได้ภาพมั่วแน่ๆ) แต่แจ้งผู้ใช้ตรงๆ ให้ลองใหม่แทน =====
    if (enhancedPrompt === "EXPANSION_FAILED") {
      return new Response(JSON.stringify({
        error: "ตอนนี้ระบบแปลคำสั่งสร้างภาพมีคนใช้งานพร้อมกันเยอะไปหน่อยค่ะ รบกวนรอสักครู่แล้วลองใหม่อีกครั้งนะคะ 🙏",
        rateLimited: true,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ===== เพิ่มใหม่: ถ้าเป็นคำขอภาพบุคคลจริงที่มีตัวตน (นักการเมือง ดารา คนดัง ฯลฯ) ไม่ส่งไปสร้างภาพต่อ
    // เพราะโมเดลสร้างภาพไม่รู้จักหน้าตาคนจริงแม่นยำอยู่แล้ว (ภาพที่ได้จะไม่ตรงกับตัวจริงแน่ๆ) และการพยายามทำให้
    // ภาพเหมือนคนจริงมากขึ้นมีความเสี่ยงเรื่องภาพปลอม/บิดเบือนข้อมูล (deepfake) จึงแจ้งข้อจำกัดตรงๆ แทน =====
    if (enhancedPrompt === "REAL_PERSON_REQUEST") {
      return new Response(JSON.stringify({
        error: "ขออภัยค่ะ ETC ไม่สามารถสร้างภาพของบุคคลจริงที่มีตัวตนได้ (เช่น นักการเมือง ดารา หรือคนดัง) เนื่องจากโมเดลสร้างภาพไม่มีข้อมูลหน้าตาคนจริงที่แม่นยำ และเพื่อป้องกันความเสี่ยงเรื่องภาพปลอมค่ะ ลองขอภาพตัวละครสมมติ สิ่งของ หรือสถานที่แทนได้นะคะ",
        realPerson: true,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // เช็คคำต้องห้ามอีกรอบกับ prompt ที่แปลแล้ว เผื่อการแปลหลุดคำไม่เหมาะสมออกมา
    if (containsBlockedContent(enhancedPrompt)) {
      return new Response(JSON.stringify({ error: "เนื้อหาไม่เหมาะสม", blocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const accountId = process.env.CF_ACCOUNT_ID;
    const apiToken = process.env.CF_API_TOKEN;
    const CF_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${IMAGE_MODEL}`;

    // ===== เพิ่มใหม่: log ทั้ง prompt ต้นฉบับและ prompt ที่แปลแล้วก่อนส่งไปวาดจริงทุกครั้ง (ดูได้ที่ Vercel Logs)
    // เผื่อภาพที่ได้ไม่ตรงกับที่ขอ จะได้เห็นเลยว่าปัญหาอยู่ที่ขั้นตอนแปล prompt (Groq เข้าใจผิด/หลุดประเด็น)
    // หรืออยู่ที่ขั้นตอนวาดภาพเอง (Flux ไม่ทำตาม prompt ที่ให้ไปทั้งที่ prompt ถูกต้องแล้ว) =====
    console.log("[generate-image] raw:", JSON.stringify(prompt), "| enhanced:", JSON.stringify(enhancedPrompt));

    const cfResponse = await fetch(CF_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        prompt: enhancedPrompt,
        // ===== แก้ไข: เดิมตั้ง steps ไว้ที่ 4 (ค่าต่ำสุด/ค่าเริ่มต้น) ซึ่งเน้นความเร็วแต่แลกกับความแม่นยำของภาพ
        // เอกสาร Cloudflare ระบุว่า steps สูงสุดที่โมเดลนี้รองรับคือ 8 และค่ายิ่งสูงยิ่งช่วยให้ภาพตรงกับ prompt มากขึ้น
        // (แลกกับเวลารอที่นานขึ้นเล็กน้อย และใช้ neuron ต่อภาพเพิ่มขึ้น แต่โควตาฟรียังเหลือเฟือสำหรับใช้งานจริง) =====
        steps: 8,
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

    if (!data.success || !data.result || !data.result.image) {
      return new Response(JSON.stringify({ error: "ไม่พบรูปภาพในคำตอบจาก Cloudflare", detail: JSON.stringify(data.errors || data) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

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
