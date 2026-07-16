// Core dependencies: Express for the HTTP server, CORS to allow the Carrd frontend
// to call this API from a different domain, Google's Gemini SDK for AI generation,
// Nodemailer to send the generated email to the user, Stripe for payment webhooks,
// and the official MongoDB driver for persistent storage.
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import nodemailer from 'nodemailer';
import Stripe from 'stripe';
import { MongoClient } from 'mongodb';

const app = express();
app.use(cors());

// Stripe requires the RAW, unparsed request body to verify its signature,
// but every other route needs JSON already parsed into an object.
// This middleware branches based on the URL so both cases are handled correctly.
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe-webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// Initialize the Gemini AI client using the API key stored in Render's environment variables.
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Stripe using the secret key, needed to verify webhook signatures.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Set up the MongoDB client using the full connection string, which already
// includes the target database name ("makecom") baked into the URI itself.
const client = new MongoClient(process.env.MONGO_SESSION_URI);
let usersCollection; // Will be assigned once the connection is established.

// Connects to MongoDB Atlas and grabs a reference to the "users" collection.
// client.db() with no argument tells the driver to use whatever database
// name is already specified inside MONGO_SESSION_URI.
async function connectDB() {
  await client.connect();
  const db = client.db();
  usersCollection = db.collection('users');
  console.log('MongoDB connected.');
}

// Looks up a single user document by email. Returns null if not found.
async function getUser(email) {
  return await usersCollection.findOne({ email });
}

// Creates a brand new user record with default free-tier values.
async function createUser(email) {
  const user = { email, status: 'free', creditsUsed: 0 };
  await usersCollection.insertOne(user);
  return user;
}

// Updates specific fields on an existing user document without touching the rest.
async function updateUser(email, updates) {
  await usersCollection.updateOne({ email }, { $set: updates });
}

// Simple health check route. Useful for confirming the deployed service is
// actually live and reachable, and doubles as a target for uptime monitors.
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'LeadGen AI Pro backend is running.'
  });
});

// Main route: takes a LinkedIn URL and user email, generates a cold email
// using Gemini, sends it to the user, and logs the lead to Make.com.
app.post('/generate', async (req, res) => {
  const { linkedinUrl, userEmail, emailTone } = req.body;

  // Basic input validation before doing any real work.
  if (!linkedinUrl || !userEmail) {
    return res.status(400).json({ success: false, message: 'Missing fields.' });
  }

  try {
    // Look up the user, or create a new free-tier record if this is their first time.
    let user = await getUser(userEmail);
    if (!user) {
      user = await createUser(userEmail);
    }

    // Enforce the free tier limit BEFORE calling the AI, so we don't waste
    // a Gemini API call on someone who's already out of credits.
    if (user.status === 'free' && user.creditsUsed >= 3) {
      return res.status(402).json({
        success: false,
        paywall: true,
        message: 'Credits exhausted. Please subscribe.'
      });
    }

    // Call Gemini to analyze the LinkedIn profile and draft a cold email in Italian.
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Analyze LinkedIn profile: ${linkedinUrl}. Write a highly persuasive cold sales email in Italian. Tone: ${emailTone || 'Professional'}. Keep it short.`,
    });
    const emailText = response.text;

    // Only increment credit usage for free-tier users; premium users are unlimited.
    let updatedCredits = user.creditsUsed;
    if (user.status === 'free') {
      updatedCredits += 1;
      await updateUser(userEmail, { creditsUsed: updatedCredits });
    }

    // Fire off the lead data to Make.com for logging (e.g. into Google Sheets).
    // Wrapped in its own try/catch so a failed webhook never breaks the main flow.
    try {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail, linkedin: linkedinUrl, status: user.status })
      });
    } catch (e) {
      console.log("Make webhook failed.");
    }

    // Set up Gmail SMTP transport using an App Password (not a normal account password).
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    // Email the generated cold email text to the user who requested it.
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: userEmail,
      subject: 'La tua Email di Vendita AI è pronta!',
      text: emailText
    });

    // Respond with success and how many free credits are left (or "Unlimited" for premium).
    res.status(200).json({
      success: true,
      remainingCredits: user.status === 'premium' ? 'Unlimited' : (3 - updatedCredits)
    });
  } catch (error) {
    // Catches failures from Gemini, Mongo, or Nodemailer and returns a generic error
    // to the client while logging the real reason server-side for debugging.
    console.log('Generate error:', error.message);
    res.status(500).json({ success: false, message: 'AI Error.' });
  }
});

// Stripe webhook route: listens for successful checkouts and upgrades the
// corresponding user to "premium" status in the database.
app.post('/stripe-webhook', async (req, res) => {
  let event;

  try {
    // Verifies the request genuinely came from Stripe using the raw body,
    // the "stripe-signature" header, and the webhook secret from Stripe's dashboard.
    // This prevents anyone from faking a "payment completed" event.
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Only act on the specific event type we care about.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details.email;

    if (customerEmail) {
      // Create the user record if they somehow don't exist yet, then
      // mark them as premium with unlimited access going forward.
      const existing = await getUser(customerEmail);
      if (!existing) {
        await createUser(customerEmail);
      }
      await updateUser(customerEmail, { status: 'premium', creditsUsed: 3 });
    }
  }

  // Stripe expects a 200 response to know the webhook was received successfully.
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;

// Connect to MongoDB FIRST, and only start accepting HTTP requests once that
// succeeds. If the database connection fails, the process exits immediately
// with a clear error instead of running silently with a broken data layer.
connectDB()
  .then(() => {
    app.listen(PORT, () => console.log('Server online.'));
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });