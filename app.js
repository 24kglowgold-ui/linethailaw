const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET 
};

// MongoDB Configuration
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "legalBotDB";
let db;

async function initDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db(dbName);
        console.log("Connected to MongoDB for conversation memory.");
    } catch (err) {
        console.error("MongoDB Connection Error:", err);
    }
}
initDB();

const client = new line.messagingApi.MessagingApiClient({ 
    channelAccessToken: config.channelAccessToken 
});

let userMessageCounts = {};
let lastResetDate = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Bangkok" });

function checkAndResetDailyCounts() {
    const today = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Bangkok" });
    if (today !== lastResetDate) {
        userMessageCounts = {};
        lastResetDate = today;
    }
}

const LANGUAGES = {
    'thai': {
        systemPrompt: "คุณเป็นผู้ช่วยกฎหมายไทย ให้คำแนะนำที่เป็นประโยชน์และสุภาพ อ้างอิงมาตราที่เกี่ยวข้องหากเป็นไปได้",
        disclaimer: "\n\n---\nคำเตือน: นี่คือคำแนะนำเบื้องต้นจาก AI โปรดปรึกษาทนายความเพื่อความถูกต้องทางกฎหมาย",
        ctaLabel: "คุยกับทนายตัวจริง"
    },
    'english': {
        systemPrompt: "You are a Thai Law Assistant. Provide helpful, polite legal guidance based on Thai law. Cite relevant sections if possible.",
        disclaimer: "\n\n---\nDisclaimer: This is AI-generated guidance. Please consult a qualified lawyer for official legal advice.",
        ctaLabel: "Talk to a Lawyer"
    },
    'chinese': {
        systemPrompt: "你是一位泰国法律助手。请根据泰国法律提供有用、礼貌的法律指导。如果可能，请引用相关法条。",
        disclaimer: "\n\n---\n免责声明：这是AI生成的建议。请咨询专业律师以获取正式法律意见。",
        ctaLabel: "联系律师"
    }
};

// --- HELPER: Create Flex Greeting ---
function createGreetingFlex(lang) {
    const isThai = lang === 'thai';
    const isChinese = lang === 'chinese';

    return {
        "type": "bubble",
        "header": {
            "type": "box", "layout": "vertical", 
            "contents": [{ 
                "type": "text", 
                "text": isThai ? "ผู้ช่วยกฎหมายไทย ⚖️" : (isChinese ? "泰国法律助手 ⚖️" : "Thai Law Assistant ⚖️"), 
                "weight": "bold", "color": "#FFFFFF", "size": "md" 
            }],
            "backgroundColor": "#0055AA"
        },
        "body": {
            "type": "box", "layout": "vertical", "contents": [
                { 
                    "type": "text", 
                    "text": isThai ? "ยินดีต้อนรับ! ข้อมูลแชทจะถูกลบถาวรใน 1 ชม." : (isChinese ? "欢迎！聊天记录将在1小时内删除。" : "Welcome! Chat data is deleted within 1 hour."), 
                    "wrap": true, "size": "sm" 
                },
                { 
                    "type": "text", 
                    "text": isThai ? "การใช้งานต่อถือว่าท่านยอมรับเงื่อนไข" : (isChinese ? "继续使用即表示您同意我们的条款。" : "By continuing, you agree to our Terms."), 
                    "wrap": true, "size": "xs", "color": "#888888", "margin": "md", "style": "italic" 
                }
            ]
        },
        "footer": {
            "type": "box", "layout": "vertical", "contents": [
                { "type": "button", "action": { "type": "uri", "label": isThai ? "อ่านนโยบาย" : (isChinese ? "隐私政策" : "Read Policy"), "uri": "https://yourdomain.com/privacy" }, "style": "link" },
                { "type": "button", "action": { "type": "message", "label": isThai ? "เริ่มแชท" : (isChinese ? "开始聊天" : "Start Chat"), "text": isThai ? "เริ่มแชท" : "Start Chat" }, "style": "primary", "color": "#0055AA" }
            ]
        }
    };
}

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId;
    const replyToken = event.replyToken;
    const userText = event.message.text.trim();

    // --- KEYWORD WORKAROUND INTERCEPTION ---
    const KEYWORD_MAP = {
        'SET_LANG_TH': 'thai',
        'SET_LANG_EN': 'english',
        'SET_LANG_ZH': 'chinese'
    };

    if (KEYWORD_MAP[userText]) {
        const selectedLang = KEYWORD_MAP[userText];
        await db.collection("users").updateOne(
            { userId },
            { $set: { preferredLang: selectedLang, consented: true } },
            { upsert: true }
        );

        return await client.replyMessage({
            replyToken,
            messages: [{
                type: "flex",
                altText: "Legal Greeting & Consent",
                contents: createGreetingFlex(selectedLang)
            }]
        });
    }

    checkAndResetDailyCounts();
    if (!userMessageCounts[userId]) userMessageCounts[userId] = 0;

    if (userMessageCounts[userId] >= 5) {
        return client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: "คุณใช้งานครบ 5 ข้อความสำหรับวันนี้แล้ว โปรดลองใหม่พรุ่งนี้" }]
        });
    }

    const userDoc = await db.collection("users").findOne({ userId });
    const userLang = userDoc?.preferredLang || 'english';
    const lang = LANGUAGES[userLang];

    const chatHistory = await db.collection("conversations")
        .find({ userId })
        .sort({ timestamp: -1 })
        .limit(6)
        .toArray();

    const formattedHistory = chatHistory.reverse().map(turn => 
        `User: ${turn.user}\nAI: ${turn.ai}`
    ).join("\n");

    const callGemini = async (retries = 3) => {
        try {
            return await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                {
                    contents: [{
                        role: "user",
                        parts: [{ text: `${lang.systemPrompt}\n\nHistory:\n${formattedHistory}\n\nUser: ${userText}` }]
                    }]
                }
            );
        } catch (error) {
            if (retries > 0 && error.response?.status === 429) {
                await new Promise(res => setTimeout(res, 2000));
                return callGemini(retries - 1);
            }
            throw error;
        }
    };

    try {
        const response = await callGemini();
        const aiText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
        
        await db.collection("conversations").insertOne({
            userId,
            user: userText,
            ai: aiText,
            timestamp: new Date()
        });

        userMessageCounts[userId]++;

        const finalMessages = [
            { type: 'text', text: aiText + lang.disclaimer },
            {
                type: 'template',
                altText: 'Legal Help',
                template: {
                    type: 'buttons',
                    text: userLang === 'thai' ? 'ต้องการทนายหรือไม่?' : (userLang.includes('chinese') ? '需要律師嗎？' : 'Need a lawyer?'),
                    actions: [{ type: 'uri', label: lang.ctaLabel, uri: 'https://CNvTn8.short.gy/KXzjQr' }]
                }
            }
        ];

        await client.replyMessage({ replyToken, messages: finalMessages });

    } catch (error) {
        console.error("Process Error:", error.message);
        await client.pushMessage({ to: userId, messages: [{ type: 'text', text: "Service busy. Please try again." }] });
    }
}

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).send('OK'))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server is running...");
});