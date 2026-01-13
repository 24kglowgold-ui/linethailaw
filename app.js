const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { MongoClient } = require('mongodb'); // Added MongoDB for memory

const app = express();

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET 
};

// MongoDB Configuration
const mongoClient = new MongoClient(process.env.MONGODB_URI || "mongodb://localhost:27017");
const dbName = "legalBotDB";
let db;

// Initialize Database Connection
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

// Memory storage for daily limits
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
        limitText: "คุณใช้สิทธิ์ครบ 5 ข้อแล้ว สมัคร...",
        disclaimer: "\n\n*ข้อความนี้เป็นเพียงการให้ข้อมูลเบื้องต้น ไม่ใช่คำแนะนำทางกฎหมายอย่างเป็นทางการ*",
        ctaLabel: "คุยกับทนาย"
    },
    // ... Chinese and English presets as in your original code
};

// HELPER: Get conversation history from MongoDB
async function getChatHistory(userId) {
    if (!db) return [];
    const history = await db.collection("history")
        .find({ userId })
        .sort({ timestamp: -1 })
        .limit(10) // Keep the last 10 exchanges for context
        .toArray();
    
    // Reverse to chronological order and format for Gemini API
    return history.reverse().flatMap(h => [
        { role: "user", parts: [{ text: h.userMessage }] },
        { role: "model", parts: [{ text: h.aiResponse }] }
    ]);
}

// HELPER: Save new exchange to MongoDB
async function saveChatTurn(userId, userMessage, aiResponse) {
    if (!db) return;
    await db.collection("history").insertOne({
        userId,
        userMessage,
        aiResponse,
        timestamp: new Date()
    });
}

app.post('/webhook', line.middleware(config), async (req, res) => {
    const events = req.body.events;
    for (let event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            await handleEvent(event);
        }
    }
    res.status(200).send('OK');
});

async function handleEvent(event) {
    const userId = event.source.userId;
    const userText = event.message.text;
    const replyToken = event.replyToken;

    checkAndResetDailyCounts();
    userMessageCounts[userId] = (userMessageCounts[userId] || 0) + 1;

    // Check language (simplified detection logic)
    const userLang = userText.match(/[ก-๙]/) ? 'thai' : 'english';
    const lang = LANGUAGES[userLang] || LANGUAGES['english'];

    if (userMessageCounts[userId] > 5) {
        return client.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: lang.limitText }]
        });
    }

    const callGemini = async (retries = 3) => {
        try {
            // Retrieve past conversation history for this user
            const history = await getChatHistory(userId);

            // Construct payload with system instructions + history + current message
            const payload = {
                system_instruction: { parts: [{ text: lang.systemPrompt }] },
                contents: [
                    ...history, // Past turns
                    { role: "user", parts: [{ text: userText }] } // Current question
                ]
            };

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                payload,
                { headers: { 'Content-Type': 'application/json' } }
            );
            return response;
        } catch (error) {
            if (retries > 0) {
                await new Promise(res => setTimeout(res, 3000));
                return callGemini(retries - 1);
            }
            throw error;
        }
    };

    try {
        const response = await callGemini();
        const aiText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
        
        // Save this turn to MongoDB for future memory
        await saveChatTurn(userId, userText, aiText);

        const finalMessages = [
            { type: 'text', text: aiText + lang.disclaimer },
            {
                type: 'template',
                altText: 'Legal Help',
                template: {
                    type: 'buttons',
                    text: userLang === 'thai' ? 'ต้องการทนายหรือไม่?' : 'Need a lawyer?',
                    actions: [{ type: 'uri', label: lang.ctaLabel, uri: 'https://CNvTn8.short.gy/KXzjQr' }]
                }
            }
        ];

        await client.replyMessage({ replyToken: replyToken, messages: finalMessages });

    } catch (error) {
        console.error("Process Error:", error.message);
        await client.pushMessage({ to: userId, messages: [{ type: 'text', text: "Service busy. Please try again." }] });
    }
}

app.listen(3000, () => console.log('Bot is running on port 3000'));