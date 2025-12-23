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

const LANGUAGES = {
    'thai': {
        systemPrompt: "You are a highly specialized AI Legal Analyst focusing on Thai Law. Respond to the user's question with accuracy, utilizing search results for grounding. Respond entirely in Thai.",
        disclaimer: "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ข้อมูลนี้ไม่ใช่คำแนะนำทางกฎหมายอย่างเป็นทางการ โปรดปรึกษาทนายความ",
        ctaLabel: "ปรึกษาทนายความ"
    },
    'english': {
        systemPrompt: "You are a highly specialized AI Legal Analyst focusing on Thai Law. Respond to the user's question with accuracy, utilizing search results for grounding. Respond entirely in English.",
        disclaimer: "\n\n**Disclaimer:** This information is not official legal advice. Please consult with a lawyer.",
        ctaLabel: "Contact Lawyer"
    }
};

function detectLanguage(text) {
    return /[\u0E00-\u0E7F]/.test(text) ? 'thai' : 'english';
}

// 2. THE WEBHOOK (Improved for Async)
app.post('/webhook', line.middleware(config), (req, res) => {
    // IMMEDIATE RESPONSE: Tell LINE we received the message (Stops the 429 loops)
    res.status(200).send('OK');

    // PROCESS IN BACKGROUND: Do the heavy lifting without making LINE wait
    req.body.events.forEach(event => {
        handleEvent(event).catch(err => console.error("Event Error:", err));
    });
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userText = event.message.text;
    const userLang = detectLanguage(userText);
    const lang = LANGUAGES[userLang] || LANGUAGES['english'];

    // --- GEMINI CALL WITH RETRY ---
    const callGemini = async (retries = 2) => {
        try {
            // Using gemini-2.0-flash-lite for higher free tier limits (30 RPM)
            return await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                contents: [{ role: "user", parts: [{ text: userText }] }],
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
        const aiText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";

        await client.replyMessage({
            replyToken: event.replyToken,
            messages: [
                { type: 'text', text: aiText + lang.disclaimer },
                {
                    type: 'template',
                    altText: 'Legal Help',
                    template: {
                        type: 'buttons',
                        text: userLang === 'thai' ? 'ต้องการทนายความหรือไม่?' : 'Need a lawyer?',
                        actions: [{ type: 'uri', label: lang.ctaLabel, uri: 'https://siamcenterlawgroup.com' }]
                    }
                }
            ]
        });
    } catch (error) {
        console.error("Gemini Error:", error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bot is live on port ${PORT}`);
});