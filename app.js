const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

// 1. Firebase Setup (Replace with your serviceAccount JSON values)
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 2. LINE Config
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error(err); res.status(500).end(); });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

  const userId = event.source.userId;
  const userRef = db.collection('users').doc(userId);
  const doc = await userRef.get();
  
  // Replicating your index.html MESSAGE_LIMIT = 5
  let count = doc.exists ? doc.data().count : 0;

  if (count >= 5) {
    return client.replyMessage(event.replyToken, {
      type: 'flex',
      altText: 'Paywall',
      contents: {
        "type": "bubble",
        "body": {
          "type": "box", "layout": "vertical",
          "contents": [
            { "type": "text", "text": "คุณได้ใช้งานครบ 5 ข้อความแล้ว", "weight": "bold", "color": "#856404" },
            { "type": "button", "action": { "type": "uri", "label": "Pay 20 THB for 1 Day", "uri": "https://docs.google.com/forms/..." }, "style": "primary", "color": "#16a34a", "margin": "md" }
          ]
        }
      }
    });
  }

  // AI Logic (Replicating your systemPrompt)
  const response = await axios.post(process.env.GEMINI_PROXY_URL, {
    contents: [{ role: "user", parts: [{ text: event.message.text }] }],
    systemInstruction: { parts: [{ text: "You are a specialized AI Legal Analyst focusing on Thai Law..." }] }
  });

  const aiText = response.data.candidates[0].content.parts[0].text;
  const disclaimer = "\n\n**ข้อความปฏิเสธความรับผิดชอบ:** ข้อมูลนี้ไม่ใช่คำแนะนำทางกฎหมายอย่างเป็นทางการ...";

  // Increment usage in Firebase
  await userRef.set({ count: count + 1 }, { merge: true });

  // Replicating your "Sponsored Card" logic
  const messages = [{ type: 'text', text: aiText + disclaimer }];
  
  if (Math.random() < 0.5) {
    messages.push({
      "type": "flex",
      "altText": "Contact Lawyer",
      "contents": {
        "type": "bubble",
        "body": {
          "type": "box", "layout": "vertical",
          "contents": [
            { "type": "text", "text": "ทนายความที่ได้รับการยืนยัน", "weight": "bold" },
            { "type": "button", "action": { "type": "uri", "label": "ติดต่อทนายความ", "uri": "https://siamcenterlawgroup.com" }, "style": "primary", "color": "#dc2626" }
          ]
        }
      }
    });
  }

  return client.replyMessage(event.replyToken, messages);
}

app.listen(process.env.PORT || 3000);