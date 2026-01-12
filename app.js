const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const { MongoClient } = require('mongodb'); // Step 1: Add MongoDB driver

const app = express();

// --- DATABASE SETUP ---
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

async function connectDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db("legal_bot"); // Connect to 'legal_bot' database
        console.log("✓ Connected to MongoDB");
    } catch (err) {
        console.error("MongoDB Connection Error:", err);
    }
}
connectDB();
// ----------------------

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET 
};

const client = new line.messagingApi.MessagingApiClient({ 
    channelAccessToken: config.channelAccessToken 
});

// System Prompts and Translations
const LANGUAGES = {
    'thai': {
        systemPrompt: "คุณคือผู้ช่วยกฎหมายไทย ตอบคำถามให้กระชับ...",
        // ... (Keep your existing language objects)
    }
};

app.post('/callback', line.middleware(config), async (req, res) => {
    const events = req.body.events;
    for (let event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            await handleMessage(event);
        }
    }
    res.sendStatus(200);
});

async function handleMessage(event) {
    const userId = event.source.userId;
    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    // 1. FETCH HISTORY: Get last 6 messages (3 turns) for this user
    const historyCol = db.collection("chat_history");
    const logs = await historyCol.find({ userId }).sort({ timestamp: -1 }).limit(6).toArray();
    
    // 2. FORMAT HISTORY: Reverse to chronological order and set roles
    const formattedHistory = logs.reverse().map(log => ({
        role: log.role, // 'user' or 'model'
        parts: [{ text: log.text }]
    }));

    // 3. GET LANGUAGE: (Use your existing logic to detect language)
    const userLang = detectLanguage(userMessage); 
    const lang = LANGUAGES[userLang];

    try {
        // 4. CALL GEMINI WITH MEMORY: Use startChat with history
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            systemInstruction: lang.systemPrompt 
        });

        const chat = model.startChat({ history: formattedHistory });
        const result = await chat.sendMessage(userMessage);
        const aiText = result.response.text();

        // 5. SAVE NEW TURN: Store user prompt and AI answer
        await historyCol.insertMany([
            { userId, role: 'user', text: userMessage, timestamp: new Date() },
            { userId, role: 'model', text: aiText, timestamp: new Date() }
        ]);

        // 6. REPLY TO LINE: (Use your existing messaging template)
        const finalMessages = [{ type: 'text', text: aiText + lang.disclaimer }];
        await client.replyMessage({ replyToken, messages: finalMessages });

    } catch (error) {
        console.error("Error:", error);
    }
}