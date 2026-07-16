import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const DATA_FILE = path.join(process.cwd(), 'users.json');

function loadUsers() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveUsers(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'LeadGen AI Pro backend is running.'
  });
});

app.post('/generate', async (req, res) => {
  const { linkedinUrl, userEmail, emailTone } = req.body;
  if (!linkedinUrl || !userEmail) {
    return res.status(400).json({ success: false, message: 'Missing fields.' });
  }

  const db = loadUsers();
  if (!db[userEmail]) {
    db[userEmail] = { status: 'free', creditsUsed: 0 };
    saveUsers(db);
  }
  const user = db[userEmail];

  if (user.status === 'free' && user.creditsUsed >= 3) {
    return res.status(402).json({
      success: false,
      paywall: true,
      message: 'Credits exhausted. Please subscribe.'
    });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Analyze LinkedIn profile: ${linkedinUrl}. Write a highly persuasive cold sales email in Italian. Tone: ${emailTone || 'Professional'}. Keep it short.`,
    });
    const emailText = response.text;

    if (user.status === 'free') {
      user.creditsUsed += 1;
      saveUsers(db);
    }

    try {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail, linkedin: linkedinUrl, status: user.status })
      });
    } catch (e) {
      console.log("Make webhook failed.");
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: userEmail,
      subject: 'La tua Email di Vendita AI è pronta!',
      text: emailText
    });

    res.status(200).json({
      success: true,
      remainingCredits: user.status === 'premium' ? 'Unlimited' : (3 - user.creditsUsed)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'AI Error.' });
  }
});

app.post('/stripe-webhook', async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (err) {
    return res.status(400).send('Webhook error');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details.email;
    if (customerEmail) {
      const db = loadUsers();
      if (!db[customerEmail]) db[customerEmail] = { creditsUsed: 3 };
      db[customerEmail].status = 'premium';
      saveUsers(db);
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server online.'));