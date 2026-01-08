const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

// --- CONFIGURATION ---
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET 
};

// Error check: If environment variables are missing, log it clearly
if (!config.channelAccessToken || !config.channelSecret || !process.env.GEMINI_API_KEY) {
    console.error("CRITICAL ERROR: Missing environment variables! Check your Render dashboard.");
}

const client = new line.messagingApi.MessagingApiClient({ 
    channelAccessToken: config.channelAccessToken 
});

// 1. IN-MEMORY TRACKER (Resets on server restart)
const userMessageCounts = {};

const LANGUAGES = {
    'thai': {
        systemPrompt: "คุณคือผู้ช่วยกฎหมายไทย ตอบคำถามให้กระชับ ตรงประเด็น และเข้าใจง่ายที่สุด ใช้ภาษาที่เป็นกันเองแต่สุภาพ หากมีข้อกฎหมายที่เกี่ยวข้องให้สรุปสั้นๆ",
        limitTitle: "ครบโควตาฟรีแล้ว",
        limitText: "คุณใช้สิทธิ์ถามฟรีครบ 5 ข้อแล้ว สมัครสมาชิก 20 บาท เพื่อใช้งานไม่จำกัด 1 วัน",
        payButton: "สมัครใช้งาน 20 บาท",
        disclaimer: "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ข้อมูลนี้ไม่ใช่คำแนะนำทางกฎหมายอย่างเป็นทางการ โปรดปรึกษาทนายความ",
        ctaLabel: "ปรึกษาทนายความ"
    },
    'english': {
        systemPrompt: "You are a Thai Law Assistant. Be direct, clear, and concise. Avoid unnecessary legal jargon and provide punchy, easy-to-understand answers.",
        limitTitle: "Daily Limit Reached",
        limitText: "You've used your 5 free questions. Subscribe for 20 THB for unlimited 1-day access.",
        payButton: "Subscribe 20 THB",
        disclaimer: "\n\n**Disclaimer:** This information is not official legal advice. Please consult with a lawyer.",
        ctaLabel: "Consult a Lawyer"
    },
    'chinese': {
        systemPrompt: "你是一位泰国法律助手。请提供直接、清晰且简练的回答。避免使用不必要的法律术语，确保回答易于理解。",
        limitTitle: "已达到每日上限",
        limitText: "您已使用 5 个免费提问额度。支付 20 泰铢即可获得 1 天无限次使用权限。",
        payButton: "支付 20 泰铢订阅",
        disclaimer: "\n\n**免责声明：** 本信息不构成正式法律建议。请咨询律师。",
        ctaLabel: "咨询律师"
    },
    'traditional_chinese': {
        systemPrompt: "您是一位泰國法律助手。請提供直接、清晰且簡練的回答。避免使用不必要的法律術語，確保回答易於理解。",
        limitTitle: "已達到每日上限",
        limitText: "您已使用 5 個免費提問額度。支付 20 泰銖即可獲得 1 天無限次使用權限。",
        payButton: "支付 20 泰銖訂閱",
        disclaimer: "\n\n**免責聲明：** 本信息不構成正式法律建議。請諮詢律師。",
        ctaLabel: "諮詢律師"
    }
};

// --- LINE LOADING ANIMATION ---
async function displayLoadingAnimation(userId) {
    try {
        await axios.post('https://api.line.me/v2/bot/chat/loading/start', {
            chatId: userId,
            loadingSeconds: 20 
        }, {
            headers: {
                'Authorization': `Bearer ${config.channelAccessToken}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (err) {
        console.error("Loading Animation Error:", err.response?.data || err.message);
    }
}

app.post('/webhook', line.middleware(config), async (req, res) => {
    try {
        const events = req.body.events;
        for (const event of events) {
            await handleEvent(event);
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error("Webhook Error:", err);
        res.status(500).end();
    }
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId;
    const replyToken = event.replyToken;
    const userText = event.message.text;

    // Detect language: Thai, Simplified Chinese, Traditional Chinese, or English
    let userLang = 'english'; 
    if (/[ก-๙]/.test(userText)) {
        userLang = 'thai';
    } else if (/[\u4e00-\u9fa5]/.test(userText)) {
        // Simple check for traditional characters to distinguish variants
        const traditionalMarkers = /[後個這國門問說]/.test(userText); 
        userLang = traditionalMarkers ? 'traditional_chinese' : 'chinese';
    }

    const lang = LANGUAGES[userLang] || LANGUAGES['english'];

    // 2. CHECK LIMIT BEFORE PROCESSING
    if (!userMessageCounts[userId]) userMessageCounts[userId] = 0;

    if (userMessageCounts[userId] >= 5) {
        return await client.replyMessage({
            replyToken: replyToken,
            messages: [{
                type: 'template',
                altText: 'Subscription Required',
                template: {
                    type: 'buttons',
                    title: lang.limitTitle,
                    text: lang.limitText,
                    actions: [
                        { 
                            type: 'uri', 
                            label: lang.payButton, 
                            uri: 'https://docs.google.com/forms/d/1nYkGB5AFiyqCqPG2zlURKJTk73GHyP8G-p33QCZ5Gh4/edit' + userId 
                        }
                    ]
                }
            }]
        }).catch(err => console.error("Limit Prompt Error:", err.message));
    }

    // 3. INCREMENT AND PROCESS
    userMessageCounts[userId]++;
    await displayLoadingAnimation(userId);

    const callGemini = async (retries = 3) => {
        try {
            return await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                contents: [{ parts: [{ text: userText }] }],
                generationConfig: { 
                    thinkingConfig: { thinkingLevel: "low" },
                    temperature: 1.0 
                },
                tools: [{ "google_search": {} }], 
                systemInstruction: { parts: [{ text: lang.systemPrompt }] }
            });
        } catch (error) {
            if (error.response?.status === 429 && retries > 0) {
                console.log("Rate limited. Waiting 3 seconds...");
                await new Promise(r => setTimeout(r, 3000));
                return callGemini(retries - 1);
            }
            throw error;
        }
    };

    try {
        const response = await callGemini();
        const candidate = response.data.candidates?.[0];
        
        if (!candidate || !candidate.content) {
            throw new Error("Empty AI response");
        }

        const aiText = candidate.content.parts?.[0]?.text || "Sorry, I couldn't generate a response.";
        const finalMessages = [
            { type: 'text', text: aiText + lang.disclaimer },
            {
                type: 'template',
                altText: 'Legal Help',
                template: {
                    type: 'buttons',
                    text: userLang === 'thai' ? 'ต้องการทนายความหรือไม่?' : (userLang.includes('chinese') ? '需要律師嗎？' : 'Need a lawyer?'),
                    actions: [{ type: 'uri', label: lang.ctaLabel, uri: 'https://siamcenterlawgroup.com' }]
                }
            }
        ];

        // Attempt to reply. If token is expired (400), use Push Message instead.
        await client.replyMessage({
            replyToken: replyToken,
            messages: finalMessages
        }).catch(async (err) => {
            if (err.status === 400) {
                console.log("Reply token expired due to latency. Sending via Push Message.");
                await client.pushMessage({
                    to: userId,
                    messages: finalMessages
                });
            } else {
                throw err;
            }
        });

    } catch (error) {
        console.error("Critical Webhook Error:", error.response?.data || error.message);
        // Inform user of error to prevent "ghosting"
        await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: "Service temporarily delayed. Please try again in a moment." }]
        }).catch(e => console.error("Fallback Push Error:", e.message));
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});