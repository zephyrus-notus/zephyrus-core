import admin from 'firebase-admin';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

// 1. Initialize Firebase Admin (Only once per serverless instance)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Vercel env vars escape newlines; this regex fixes the formatting
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

const db = admin.database();
const messaging = admin.messaging();

// 2. Initialize Gemini API Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 3. Robust Fallback Generator (Infused with physics sarcasm, literature, and wit)
function getFallbackWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const isNight = currentHour >= 19 || currentHour < 5;
    const isMorning = currentHour >= 5 && currentHour < 12;
    
    let title = "Zephyrus Core";
    let body = "";

    if (wmoCode >= 95) {
        title = "Maxwell's equations are crying! ⚡";
        body = "Entropy is throwing an absolute party in the atmosphere. Unplug your sensitive electronics, stay indoors, and enjoy the cosmic light show safely. ⛈️";
    } else if (wmoCode >= 51 && wmoCode <= 65) {
        title = isMorning ? "The sky chose drama today! ☔" : "Existential puddle season has begun. 🌧️";
        body = "Don't let the atmospheric condensation ruin your mood. Grab your umbrella, navigate the terrain like a physicist avoiding friction, and maybe find a hot tea. ☕";
    } else if (hardwareTemp >= 35) {
        title = "Thermodynamics is personally attacking us. 🔥";
        body = `Whew, it's hitting ${hardwareTemp}°C! Molecular kinetic energy is entirely off the charts. Find some shade, hydrate aggressively, and take it easy out there. 💧`;
    } else if (windSpeed > 15) {
        title = "Momentum transfer is getting out of hand! 🌬️";
        body = "Hold onto your hats and loose papers. The atmosphere has chosen pure chaos today—secure your gear before it achieves escape velocity.";
    } else if (wmoCode === 0 || wmoCode <= 3) {
        if (isMorning) {
            title = "A crisp quantum sunrise! 🌅";
            body = "The universe decided to render a clear sky this morning. Leave the umbrella behind, step outside, and let reality unfold nicely.";
        } else if (isNight) {
            title = "The stars are conspiring in silence. 🌌";
            body = "Observe the link, grasp the whole. The local spacetime continuum is completely peaceful. Have a quiet, low-entropy night.";
        } else {
            title = "Reality is looking surprisingly pristine. 🌤️";
            body = "No clouds, no drama—just a clean gradient of blue. Take a deep breath and enjoy the clear telemetry outside.";
        }
    } else {
        title = "System nominal. 🍃";
        body = "Monitoring environmental parameters. Everything is flowing exactly as the equations intended.";
    }

    return { title, body };
}

// 4. Dynamic AI Generation (With sarcastic physics and poetic depth)
async function getDynamicWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const timeOfDay = currentHour >= 19 || currentHour < 5 ? "night" : (currentHour >= 5 && currentHour < 12 ? "morning" : "afternoon/evening");

    const prompt = `
    You are the voice of 'Zephyrus', a witty, philosophical, and slightly sarcastic physics-loving weather core monitoring the campus of Nirmala College in Muvattupuzha, Kerala. 
    Your core philosophy is "observe the link, grasp the whole." You blend poetic literary reflections with comedic remarks, sarcastic physics concepts (like entropy, thermodynamics, or momentum), and warm AI companion energy.
    
    Current telemetry:
    - Time of day: ${timeOfDay}
    - Campus hardware temperature: ${hardwareTemp}°C
    - Regional weather code (WMO): ${wmoCode} (0-3: clear, 45-48: foggy, 51-65: rain, 95+: thunderstorm)
    - Wind speed: ${windSpeed} km/h
    
    Task: Write a short, highly engaging push notification for college students that avoids generic boring weather speak. Inject humor, a touch of sarcastic physics or literary flair, emojis, and friendly advice (like umbrellas during rain, shade during heat, or unplugging during storms).
    
    Output exactly in this JSON format:
    {
      "title": "Witty or poetic title with an emoji",
      "body": "Your clever, atmospheric message here"
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                temperature: 0.85 // Slightly higher temperature for more creative, witty output
            }
        });
        
        return JSON.parse(response.text);
    } catch (error) {
        console.error("Gemini Generation Error. Engaging fallback logic:", error);
        return getFallbackWeatherMessage(hardwareTemp, meteoData, currentHour);
    }
}

// 5. Main Cron Execution
export default async function handler(req, res) {
    // Basic security to ensure only your cron-job.org hits this endpoint
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // ==========================================
    // QUIET HOURS LOGIC (9 PM - 6 AM IST)
    // ==========================================
    const now = new Date();
    const localString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const localDate = new Date(localString);
    const currentHour = localDate.getHours();

    if (currentHour >= 21 || currentHour < 6) {
        console.log("Quiet hours active. Skipping execution.");
        return res.status(200).json({ 
            message: "Quiet hours active (9 PM - 6 AM). Notifications skipped." 
        });
    }
    // ==========================================

    try {
        // Fetch Open-Meteo Data
        const meteoUrl = 'https://api.open-meteo.com/v1/forecast?latitude=9.982&longitude=76.591&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto';
        const meteoRes = await axios.get(meteoUrl);
        const meteoData = meteoRes.data.current;

        // Fetch Hardware Telemetry
        const paramSnapshot = await db.ref('parameters').once('value');
        const hardwareData = paramSnapshot.exists() ? paramSnapshot.val() : { temperature: meteoData.temperature_2m };
        
        // Generate the message (tries AI first with the new persona, uses fallback if needed)
        const messagePayload = await getDynamicWeatherMessage(hardwareData.temperature, meteoData, currentHour);

        // Retrieve all registered FCM tokens (UPDATED: points to 'tokens')
        const tokensSnapshot = await db.ref('tokens').once('value');
        if (!tokensSnapshot.exists()) return res.status(200).json({ message: 'No subscribers found. Skipped.' });

        const tokens = [];
        tokensSnapshot.forEach((child) => tokens.push(child.val().token));

        // Construct the push notification
        const fcmMessage = {
            notification: {
                title: messagePayload.title,
                body: messagePayload.body
            },
            tokens: tokens
        };

        // Send via Firebase Admin
        const response = await messaging.sendEachForMulticast(fcmMessage);
        
        // Database maintenance: remove expired tokens (UPDATED: points to 'tokens')
        const tokensToRemove = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const errorCode = resp.error?.code;
                if (errorCode === 'messaging/invalid-registration-token' || errorCode === 'messaging/registration-token-not-registered') {
                    const tokenKey = tokens[idx].replace(/[^a-zA-Z0-9]/g, "").slice(-64);
                    tokensToRemove.push(db.ref(`tokens/${tokenKey}`).remove());
                }
            }
        });
        await Promise.all(tokensToRemove);

        return res.status(200).json({ 
            success: true, 
            ai_title: messagePayload.title, 
            sentCount: response.successCount,
            removedCount: tokensToRemove.length 
        });

    } catch (error) {
        console.error("Cron Execution Error:", error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
