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

// 1. LANGUAGE DATA (Mirrored from index.html)
const LANGUAGES = {
    'thai': {
        systemPrompt: "You are a highly specialized AI Legal Analyst focusing on Thai Law. Respond to the user's question with accuracy, utilizing search results for grounding. Your response must be generated entirely and clearly in the Thai language.",
        disclaimer: "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ข้อมูลนี้ไม่ใช่คำแนะนำทางกฎหมายอย่างเป็นทางการ โปรดปรึกษาทนายความเพื่อการตัดสินใจที่แม่นยำที่สุด",
        ctaLabel: "ปรึกษาทนายความ"
    },
    'english': {
        systemPrompt: "You are a highly specialized AI Legal Analyst focusing on Thai Law. Respond to the user's question with accuracy, utilizing search results for grounding. Your response must be generated entirely and clearly in the English language.",
        disclaimer: "\n\n**Disclaimer:** This information is not official legal advice. Please consult with a lawyer for professional guidance.",
        ctaLabel: "Contact Lawyer"
    },
    'chinese': {
        systemPrompt: "You are a highly specialized AI Legal Analyst focusing on Thai Law. Respond to the user's question with accuracy, utilizing search results for grounding. Your response must be generated entirely and clearly in the Chinese language.",
        disclaimer: "\n\n**免责声明：** 此信息并非官方法律建议。请咨询律师以获得专业指导。",
        ctaLabel: "联系律师"
    }
};

// Helper: Detect language based on character range
function detectLanguage(text) {
    if (/[\u0E00-\u0E7F]/.test(text)) return 'thai';
    if (/[\u4E00-\u9FFF]/.test(text)) return 'chinese';
    return 'english';
}

// 2. WEBHOOK ENDPOINT
app.post('/webhook', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(() => res.status(200).send('OK'))
        .catch((err) => {
            console.error("Webhook Error:", err);
            res.status(500).end();
        });
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const userText = event.message.text;
    const userLang = detectLanguage(userText);
    const lang = LANGUAGES[userLang];

    try {
        // 3. CALL GEMINI 2.0 FLASH API
        // Updated to the v1beta gemini-2.0-flash endpoint
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
            contents: [{ role: "user", parts: [{ text: userText }] }],
            tools: [{ "google_search": {} }],
            systemInstruction: { parts: [{ text: lang.systemPrompt }] }
        });

        const aiText = response.data.candidates[0].content.parts[0].text;

        // 4. REPLY WITH BUTTONS (CTA)
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [
                {
                    type: 'text',
                    text: aiText + lang.disclaimer
                },
                {
                    type: 'template',
                    altText: 'Legal Help',
                    template: {
                        type: 'buttons',
                        text: userLang === 'thai' ? 'ต้องการความมั่นใจ 100% หรือไม่?' : 'Need 100% certainty?',
                        actions: [
                            {
                                type: 'uri',
                                label: lang.ctaLabel,
                                uri: 'https://siamcenterlawgroup.com'
                            }
                        ]
                    }
                }
            ]
        });
    } catch (error) {
        console.error("Gemini Error:", error.response ? error.response.data : error.message);
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: 'Error processing request. Please try again later.' }]
        });
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot Server running on port ${PORT}`));