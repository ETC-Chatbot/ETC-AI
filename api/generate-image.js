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
const CHAT_MODEL = "qwen/qwen3.6-27b"; // โมเดลเดียวกับที่ใช้ใน chat.js

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
        model: CHAT_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a prompt writer for a text-to-image AI model. The user will give you a short request, possibly in Thai. Rewrite it into ONE vivid, detailed English prompt suitable for image generation: describe the subject, setting, colors, and style concretely. If the request mentions a country, culture, or place (e.g. Thailand), include specific recognizable visual elements of it (landmarks, clothing, scenery). ===== เพิ่มใหม่: ต้องระบุชัดเจนเสมอว่าห้ามมีตัวหนังสือ ป้าย หรือกราฟิกข้อความใดๆ ปรากฏในภาพ เพราะโมเดลชอบสุ่มใส่ตัวอักษรมั่วๆ (มักเป็นภาษาจีน/ญี่ปุ่น) ลงไปเวลา prompt ไม่ชัดเจนพอ ===== Always end your prompt with: 'photorealistic photograph, no text, no writing, no letters, no captions, no watermark, no infographic elements'. Reply with ONLY the rewritten English prompt, no quotes, no explanation, no extra text.",
          },
          { role: "user", content: rawPrompt },
        ],
        temperature: 0.7,
        max_tokens: 200,
        stream: false,
      }),
    });

    if (!res.ok) return rawPrompt;

    const data = await res.json();
    const expanded = data.choices?.[0]?.message?.content?.trim();
    if (!expanded) return rawPrompt;

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
  } catch {
    // ถ้าเชื่อมต่อ Groq มีปัญหาอะไรก็ตาม ให้ใช้ prompt เดิมแทน ไม่ให้ทั้งฟีเจอร์พังไปด้วย
    return rawPrompt;
  }
}

export default async function handler(req) {
  // ===== เพิ่มใหม่: ตัวบอกเวอร์ชันโค้ด เช็คได้จาก Vercel > โปรเจกต์ > แท็บ Logs ว่าไฟล์นี้ถูก deploy จริงหรือยัง =====
  console.log("[generate-image build: 2026-09-09-fix-refusal-fallback]");
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
