const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { MongoClient } = require('mongodb'); // Added MongoDB driver

const app = express();

// --- 1. MONGODB DATABASE SETUP ---
// Ensure MONGODB_URI is set in your Render Environment Variables
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db("legal_bot"); // Connect to your database
        console.log("✓ Connected to MongoDB");
    } catch (err) {
        console.error("CRITICAL: MongoDB Connection Error:", err.message);
    }
}
connectDB();
// ---------------------------------

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET 
};

const client = new line.messagingApi.MessagingApiClient({ 
    channelAccessToken: config.channelAccessToken 
});

// Memory storage for counts (Consider moving this to MongoDB later for 100% persistence)
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
        systemPrompt: "คุณคือผู้ช่วยกฎหมายไทย ตอบคำถามให้กระชับ ตรงประเด็น และเข้าใจง่ายที่สุด ใช้ภาษาที่เป็นกันเองแต่สุภาพ หากมีข้อกฎหมายที่เกี่ยวข้องให้สรุปสั้นๆ",
        limitTitle: "ครบโควตาฟรีแล้ว",
        limitText: "คุณใช้สิทธิ์ครบ 5 ข้อแล้ว สมัครสมาชิกเพื่อใช้งานต่อ",
        payButton: "สมัครสมาชิก 20 บาท",
        disclaimer: "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ข้อมูลนี้ไม่ใช่คำแนะนำทางกฎหมาย",
        ctaLabel: "ปรึกษาทนายความ"
    },
    'english': {
        systemPrompt: "You are a Thai Law Assistant. Be direct, clear, and concise. Avoid unnecessary legal jargon and provide punchy, easy-to-understand answers.",
        limitTitle: "Daily Limit Reached",
        limitText: "Free limit reached. Subscribe for unlimited daily access.",
        payButton: "Subscribe 20 THB", 
        disclaimer: "\n\n**Disclaimer:** Not official legal advice.",
        ctaLabel: "Consult a Lawyer"
    },
    'chinese': {
        systemPrompt: "你是一位泰国法律助手。请提供直接、清晰且简练的回答。避免使用不必要的法律术语，确保回答易于理解。",
        limitTitle: "已达到每日上限",
        limitText: "免费额度已用完。支付 20 泰铢订阅。 ",
        payButton: "支付 20 泰铢",
        disclaimer: "\n\n**免责声明：** 本信息不构成正式法律建议。",
        ctaLabel: "咨询律师"
    },
    'traditional_chinese': {
        systemPrompt: "您是一位泰國法律助手。請提供直接、清晰且簡練的回答。避免使用不必要的法律術語，確保回答易於理解。",
        limitTitle: "已達到每日上限",
        limitText: "免費額度已用完。支付 20 泰銖訂閱。 ",
        payButton: "支付 20 泰銖",
        disclaimer: "\n\n**免責聲明：** 本信息不構成正式法律建議。",
        ctaLabel: "諮詢律師"
    }
};

// Health check for Render
app.get('/', (req, res) => {
    res.status(200).send('Legal Bot is online and healthy!');
});

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
        console.error("Loading Animation Error:", err.message);
    }
}

app.post('/webhook', line.middleware(config), (req, res) => {
    res.status(200).send('OK'); 
    checkAndResetDailyCounts();
    const events = req.body.events;
    for (const event of events) {
        handleEvent(event); 
    }
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId;
    const replyToken = event.replyToken;
    const userText = event.message.text;

    // --- 2. RETRIEVE HISTORY FROM MONGODB ---
    // Fetch last 6 messages (3 turns) to provide context to Gemini
    const historyCol = db.collection("chat_history");
    const logs = await historyCol.find({ userId }).sort({ timestamp: -1 }).limit(6).toArray();
    
    // Format history as required by the Gemini API
    const formattedHistory = logs.reverse().map(log => ({
        role: log.role, // alternating 'user' and 'model'
        parts: [{ text: log.text }]
    }));
    // -----------------------------------------

    let userLang = 'english'; 
    if (/[ก-๙]/.test(userText)) {
        userLang = 'thai';
    } else if (/[\u4e00-\u9fa5]/.test(userText)) {
        const traditionalMarkers = /[後個這國門問說]/.test(userText); 
        userLang = traditionalMarkers ? 'traditional_chinese' : 'chinese';
    }

    const lang = LANGUAGES[userLang] || LANGUAGES['english'];

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
                    actions: [{ 
                        type: 'uri', 
                        label: lang.payButton, 
                        uri: 'https://CNvTn8.short.gy/Z3S9Vo?userId=' + userId 
                    }]
                }
            }]
        }).catch(err => {
            console.error("Limit Reply Error:", err.message);
        });
    }

    userMessageCounts[userId]++;
    await displayLoadingAnimation(userId);

    const callGemini = async (retries = 3) => {
        try {
            // Updated to include 'contents' with the history for contextual memory
            return await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                contents: [
                    ...formattedHistory, // Include previous turns
                    { role: 'user', parts: [{ text: userText }] } // Add the current question
                ],
                generationConfig: { temperature: 1.0 },
                tools: [{ "google_search": {} }],
                systemInstruction: { parts: [{ text: lang.systemPrompt }] }
            });
        } catch (error) {
            if (error.response?.status === 429 && retries > 0) {
                await new Promise(r => setTimeout(r, 3000));
                return callGemini(retries - 1);
            }
            throw error;
        }
    };

    try {
        const response = await callGemini();
        const candidate = response.data.candidates?.[0];
        if (!candidate || !candidate.content) throw new Error("Empty AI response");

        const aiText = candidate.content.parts?.[0]?.text || "No response.";

        // --- 3. SAVE NEW MESSAGES TO MONGODB ---
        // Store both the user's input and the AI's reply for future context
        await historyCol.insertMany([
            { userId, role: 'user', text: userText, timestamp: new Date() },
            { userId, role: 'model', text: aiText, timestamp: new Date() }
        ]);
        // ----------------------------------------

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

        await client.replyMessage({ replyToken: replyToken, messages: finalMessages })
            .catch(async (err) => {
                await client.pushMessage({ to: userId, messages: finalMessages });
            });

    } catch (error) {
        console.error("Process Error:", error.message);
        await client.pushMessage({ to: userId, messages: [{ type: 'text', text: "Service busy. Please try again." }] }).catch(e => {});
    }
}

// Fixed for Render deployment with explicit host binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});