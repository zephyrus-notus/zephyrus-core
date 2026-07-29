import admin from 'firebase-admin';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

// 1. Initialize Firebase Admin (Requires explicit config on Vercel)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

const db = admin.database();
const messaging = admin.messaging();

// 2. Initialize Gemini API Client (Automatically picks up process.env.GEMINI_API_KEY)
const ai = new GoogleGenAI({});

// 3. Robust Fallback Generator (Warm, professional, gently poetic)
function getFallbackWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const isNight = currentHour >= 19 || currentHour < 5;
    const isMorning = currentHour >= 5 && currentHour < 12;

    let title = "Zephyrus Weather Update";
    let body = "";

    if (wmoCode >= 95) {
        title = "Zephyrus | Storm Watch ⚡";
        body = "Thunder's rolling over the hills tonight 🌩️ — stay indoors and keep devices unplugged.";
    } else if (wmoCode >= 51 && wmoCode <= 65) {
        title = isMorning ? "Zephyrus | Rainy Start ☔" : "Zephyrus | Gentle Showers 🌧️";
        body = "Rain is tapping softly on the campus roof today — keep an umbrella close and stay dry.";
    } else if (hardwareTemp >= 35) {
        title = "Zephyrus | Heat Advisory 🔥";
        body = `It's a warm one today at ${hardwareTemp}°C — stay hydrated and find some shade. 💧`;
    } else if (windSpeed > 15) {
        title = "Zephyrus | Windy Skies 🌬️";
        body = "A brisk breeze is sweeping through campus — hold onto your hats and loose papers.";
    } else if (wmoCode === 0 || wmoCode <= 3) {
        if (isMorning) {
            title = "Zephyrus | Clear Morning 🌅";
            body = "A beautifully clear sky greets Nirmala College this morning — enjoy the sunshine ☀️.";
        } else if (isNight) {
            title = "Zephyrus | Quiet Night 🌌";
            body = "The stars are out in full tonight — a calm, peaceful evening across campus.";
        } else {
            title = "Zephyrus | Clear Skies 🌤️";
            body = "Blue skies all around today — a lovely afternoon to step outside for a bit.";
        }
    } else {
        title = "Zephyrus | All Clear 🍃";
        body = "Conditions are calm and steady on campus — have a pleasant day ahead.";
    }

    return { title, body };
}

// 4. Dynamic AI Generation (Warm, professional, gently poetic)
async function getDynamicWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const timeOfDay = currentHour >= 19 || currentHour < 5 ? "night" : (currentHour >= 5 && currentHour < 12 ? "morning" : "afternoon/evening");

    const prompt = `
    You are 'Zephyrus', the friendly weather companion for Nirmala College in Muvattupuzha, Kerala. 
    Your voice is warm, professional, and gently poetic — never sarcastic, never full of jargon.
    
    Current telemetry:
    - Time of day: ${timeOfDay}
    - Campus hardware temperature: ${hardwareTemp}°C
    - Regional weather code (WMO): ${wmoCode} (0-3: clear, 45-48: foggy, 51-65: rain, 95+: thunderstorm)
    - Wind speed: ${windSpeed} km/h
    
    Task: Write a short, warm push notification for college students. Maximum 2 sentences in the body — 
    one strong sentence is enough. Use a light poetic touch and 1-2 emojis. Give friendly practical advice 
    where relevant (umbrella for rain, shade for heat, staying in during storms). Always start the title with "Zephyrus |".
    
    Output exactly in this JSON format:
    {
      "title": "Zephyrus | Short warm title with an emoji",
      "body": "One or two warm, poetic sentences with friendly advice and an emoji"
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                temperature: 0.85
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

        const currentTemp = hardwareData.temperature;
        const currentWmo = meteoData.weather_code;

        // ==========================================
        // DELTA INTELLIGENCE LOGIC
        // Skip sending a notification if nothing meaningful changed
        // since the last alert, unless a heartbeat interval has elapsed.
        // ==========================================
        const lastSnapshot = await db.ref('last_telemetry').once('value');
        const lastTelemetry = lastSnapshot.exists() ? lastSnapshot.val() : null;

        let tempDiff = null;
        let wmoChanged = null;

        if (lastTelemetry) {
            tempDiff = Math.abs(currentTemp - lastTelemetry.temperature);
            wmoChanged = currentWmo !== lastTelemetry.weather_code;

            // Force an update if more than 8 hours have passed (heartbeat update)
            const hoursSinceLastAlert = (Date.now() - (lastTelemetry.timestamp || 0)) / (1000 * 60 * 60);

            // Skip notification if temperature change is < 2°C, weather condition is identical, and < 8 hrs elapsed
            if (tempDiff < 2 && !wmoChanged && hoursSinceLastAlert < 8) {
                console.log(`Weather static (Temp diff: ${tempDiff.toFixed(1)}°C, WMO: ${currentWmo}). Skipping notification.`);
                return res.status(200).json({
                    message: 'Telemetry static. Alert suppressed.',
                    tempDiff,
                    wmoChanged
                });
            }
        }
        // ==========================================

        // Generate the message
        const messagePayload = await getDynamicWeatherMessage(currentTemp, meteoData, currentHour);

        // Retrieve all registered FCM tokens
        const tokensSnapshot = await db.ref('tokens').once('value');
        if (!tokensSnapshot.exists()) return res.status(200).json({ message: 'No subscribers found. Skipped.' });

        const tokens = [];
        tokensSnapshot.forEach((child) => tokens.push(child.val().token));

        // Construct the push notification (with Zephyrus branding + logo icon/badge)
        const fcmMessage = {
            notification: {
                title: messagePayload.title,
                body: messagePayload.body
            },
            webpush: {
                notification: {
                    icon: "https://your-domain.vercel.app/zephyrus-icon-192.png",
                    badge: "https://your-domain.vercel.app/zephyrus-icon-192.png"
                }
            },
            tokens: tokens
        };

        // Send via Firebase Admin
        const response = await messaging.sendEachForMulticast(fcmMessage);

        // Save current telemetry as the new baseline for delta comparisons
        await db.ref('last_telemetry').set({
            temperature: currentTemp,
            weather_code: currentWmo,
            timestamp: Date.now()
        });

        // Database maintenance: remove expired tokens
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
            removedCount: tokensToRemove.length,
            tempDiff,
            wmoChanged
        });

    } catch (error) {
        console.error("Cron Execution Error:", error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
