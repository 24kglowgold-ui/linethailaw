async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const userText = event.message.text;
    const userLang = detectLanguage(userText);
    const lang = LANGUAGES[userLang];

    // --- RETRY LOGIC FOR 429 ERRORS ---
    const callGeminiWithRetry = async (retries = 3, delay = 2000) => {
        try {
            // Using gemini-2.0-flash-lite for higher free-tier limits
            return await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                contents: [{ role: "user", parts: [{ text: userText }] }],
                tools: [{ "google_search": {} }],
                systemInstruction: { parts: [{ text: lang.systemPrompt }] }
            });
        } catch (error) {
            // If we hit a 429 and have retries left, wait and try again
            if (error.response?.status === 429 && retries > 0) {
                console.log(`Rate limit (429) hit. Retrying in ${delay}ms... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return callGeminiWithRetry(retries - 1, delay * 2); // Double the wait time
            }
            throw error; // If it's a different error or we ran out of retries
        }
    };

    try {
        const response = await callGeminiWithRetry();
        
        // Safety check to ensure the AI actually generated text
        const aiText = response.data.candidates?.[0]?.content?.parts?.[0]?.text 
                       || (userLang === 'thai' ? "ขออภัย ฉันไม่สามารถตอบคำถามนี้ได้ในขณะนี้" : "Sorry, I cannot answer this right now.");

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
        console.error("Final Gemini Error after retries:", error.response?.data || error.message);
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: 'Server busy. Please try again in 1 minute.' }]
        });
    }
}