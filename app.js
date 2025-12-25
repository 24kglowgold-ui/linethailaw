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

const LANGUAGES = {
    'thai': {
        systemPrompt: "คุณคือผู้เชี่ยวชาญด้านกฎหมายไทย วิเคราะห์คำถามอย่างละเอียดด้วยตรรกะระดับสูง ตอบกลับเป็นภาษาไทยเท่านั้น",
        disclaimer: "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ข้อมูลนี้ไม่ใช่คำแนะนำทางกฎหมายอย่างเป็นทางการ",
        ctaLabel: "ปรึกษาทนายความ"
    },
    'english': {
        systemPrompt: "You are a specialized Thai Law Analyst. Use Gemini 3.0 logic to provide accurate legal reasoning. Respond entirely in English.",
        disclaimer: "\n\n**Disclaimer:** This information is not official legal advice.",
        ctaLabel: "Consult a Lawyer"
    }
};

// --- NEW: LINE LOADING ANIMATION ---
// Displays typing dots in the chat to tell the user the bot is working
async function displayLoadingAnimation(userId) {
    try {
        await axios.post('https://api.line.me/v2/bot/chat/loading/start', {
            chatId: userId,
            loadingSeconds: 15 // Increased to 15s to cover the "Medium" thinking time
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.channelAccessToken}`
            }
        });
    } catch (err) {
        console.error("Loading Animation Error:", err.response?.data || err.message);
    }
}

app.post('/webhook', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(() => res.json({}))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId;
    const userText = event.message.text;
    const userLang = /[ก-๙]/.test(userText) ? 'thai' : 'english';
    const lang = LANGUAGES[userLang] || LANGUAGES['english'];

    // 1. Trigger Loading Animation immediately
    await displayLoadingAnimation(userId);

    const callGemini = async (retries = 2) => {
        try {
            // 2. Updated to Gemini 3.0 Flash Preview
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${process.env.GEMINI_API_KEY}`;
            
            return await axios.post(url, {
                contents: [{ role: "user", parts: [{ text: userText }] }],
                generationConfig: {
                    // 3. Modified Thinking Level to "medium" for balanced reasoning
                    thinkingConfig: { 
                        thinkingLevel: "medium" 
                    }
                },
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
        const aiText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "Error.";

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
        console.error("Bot Error:", error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot active on port ${PORT}`));