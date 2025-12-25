const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

// --- CONFIGURATION ---
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET 
};

const client = new line.messagingApi.MessagingApiClient({ 
    channelAccessToken: config.channelAccessToken 
});

// 1. IN-MEMORY TRACKER (Resets on server restart)
const userMessageCounts = {};

const LANGUAGES = {
    'thai': {
        systemPrompt: "คุณคือผู้เชี่ยวชาญด้านกฎหมายไทย...",
        limitTitle: "ครบโควตาฟรีแล้ว",
        limitText: "คุณใช้สิทธิ์ถามฟรีครบ 5 ข้อแล้ว สมัครสมาชิก 20 บาท เพื่อใช้งานไม่จำกัด 1 วัน",
        payButton: "สมัครใช้งาน 20 บาท",
        disclaimer: "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ..."
    },
    'english': {
        systemPrompt: "You are a specialized Thai Law Analyst...",
        limitTitle: "Daily Limit Reached",
        limitText: "You've used your 5 free questions. Subscribe for 20 THB for unlimited 1-day access.",
        payButton: "Subscribe 20 THB",
        disclaimer: "\n\n**Disclaimer:** ..."
    }
};

app.post('/webhook', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(() => res.json({}))
        .catch((err) => res.status(500).end());
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId; // Unique LINE User ID
    const userText = event.message.text;
    const userLang = /[ก-๙]/.test(userText) ? 'thai' : 'english';
    const lang = LANGUAGES[userLang] || LANGUAGES['english'];

    // 2. CHECK LIMIT BEFORE PROCESSING
    if (!userMessageCounts[userId]) userMessageCounts[userId] = 0;

    if (userMessageCounts[userId] >= 5) {
        // Skip Gemini and send Subscription Prompt
        return await client.replyMessage({
            replyToken: event.replyToken,
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
        });
    }

    // 3. INCREMENT AND PROCESS (Normal Flow)
    userMessageCounts[userId]++;
    
    // Call Loading Animation and Gemini 3.0 logic here...
    // await startLoading(userId);
    // const response = await callGemini();
    // ... rest of your code
}