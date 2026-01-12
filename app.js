const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { MongoClient } = require('mongodb'); //

const app = express();

// --- 1. MONGODB SETUP ---
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectDB() {
    console.log("Attempting to connect to MongoDB..."); 
    try {
        await mongoClient.connect();
        db = mongoClient.db("legal_bot");
        console.log("✓ Connected to MongoDB");
    } catch (err) {
        // Detailed logging to find why the "✓" message isn't appearing
        console.error("CRITICAL MongoDB Error:", err.message);
    }
}
connectDB();

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET 
};

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
        systemPrompt: "คุณคือผู้ช่วยกฎหมายไทย ตอบคำถามให้กระชับ ตรงประเด็น และเข้าใจง่ายที่สุด",
        disclaimer: "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ข้อมูลนี้ไม่ใช่คำแนะนำทางกฎหมาย"
    },
    'english': {
        systemPrompt: "You are a Thai Law Assistant. Be direct, clear, and concise.",
        disclaimer: "\n\n**Disclaimer:** Not official legal advice."
    }
};

// Health Check for Render
app.get('/', (req, res) => res.status(200).send('Bot is Live'));

app.post('/webhook', line.middleware(config), (req, res) => {
    res.status(200).send('OK'); 
    checkAndResetDailyCounts();
    const events = req.body.events;
    for (const event of events) { handleEvent(event); }
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId;
    const userText = event.message.text;

    // --- 2. GET HISTORY FROM DB ---
    const historyCol = db.collection("chat_history");
    const logs = await historyCol.find({ userId }).sort({ timestamp: -1 }).limit(6).toArray();
    const formattedHistory = logs.reverse().map(log => ({
        role: log.role,
        parts: [{ text: log.text }]
    }));

    const userLang = /[ก-๙]/.test(userText) ? 'thai' : 'english';
    const lang = LANGUAGES[userLang];

    if (!userMessageCounts[userId]) userMessageCounts[userId] = 0;
    if (userMessageCounts[userId] >= 5) return; 

    userMessageCounts[userId]++;

    try {
        // --- 3. CALL GEMINI (STABLE VERSION) ---
        // FIXED: Using 'gemini-1.5-flash' to resolve the 404 error
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
            contents: [
                ...formattedHistory, // Sending conversation history
                { role: 'user', parts: [{ text: userText }] }
            ],
            systemInstruction: { parts: [{ text: lang.systemPrompt }] }
        });

        const aiText = response.data.candidates[0].content.parts[0].text;

        // --- 4. SAVE NEW TURN TO DB ---
        await historyCol.insertMany([
            { userId, role: 'user', text: userText, timestamp: new Date() },
            { userId, role: 'model', text: aiText, timestamp: new Date() }
        ]);

        await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: aiText + lang.disclaimer }]
        });

    } catch (error) {
        console.error("Process Error:", error.message);
    }
}

// Host binding for Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));