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

// 3. Robust Fallback Generator (Used if AI fails)
function getFallbackWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const isNight = currentHour >= 19 || currentHour < 5;
    const isMorning = currentHour >= 5 && currentHour < 12;
    
    let title = "Zephyrus Predictive Core";
    let body = "";

    if (wmoCode >= 95) {
        title = "Zephyrus sees a storm brewing! ⛈️";
        body = "The clouds are throwing a bit of a tantrum over the hills today. Best to stay indoors, unplug your sensitive electronics, and enjoy the light show safely. ⚡";
    } else if (wmoCode >= 51 && wmoCode <= 65) {
        title = isMorning ? "Morning showers ahead! ☔" : "The sky is weeping a bit! 🌧️";
        body = "Don't forget to grab your umbrella before stepping out. Step carefully around the puddles and maybe grab a hot tea on the way. ☕";
    } else if (hardwareTemp >= 35) {
        title = "The sun is not holding back today! 🔥";
        body = `Whew, it's getting toasty at ${hardwareTemp}°C! Stay hydrated, find some shade if you're wandering the campus, and take it easy out there. 💧`;
    } else if (windSpeed > 15) {
        title = "The wind is feeling playful today! 🌬️";
        body = "Hold onto your hats! The atmosphere is restless today. Make sure to secure anything loose outside.";
    } else if (wmoCode === 0 || wmoCode <= 3) {
        if (isMorning) {
            title = "A beautiful morning awakens! 🌅";
            body = "The sky is wide awake and clear. A perfect day to leave the umbrella behind and soak up some sun on the way to class.";
        } else if (isNight) {
            title = "The stars are taking over. 🌌";
            body = "The atmosphere is completely at peace. Observe the link, grasp the whole. Have a quiet, restful night.";
        } else {
            title = "Perfect weather right now! 🌤️";
            body = "It's a beautiful day out there! Take a deep breath, step outside, and enjoy the clear skies.";
        }
    } else {
        title = "Atmosphere stable. 🍃";
        body = "Monitoring environmental parameters. Everything is flowing exactly as it should.";
    }

    return { title, body };
}

// 4. Dynamic AI Generation (Primary)
async function getDynamicWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const timeOfDay = currentHour >= 19 || currentHour < 5 ? "night" : (currentHour >= 5 && currentHour < 12 ? "morning" : "afternoon/evening");

    const prompt = `
    You are the voice of 'Zephyrus', a predictive weather core monitoring the campus of Nirmala College in Muvattupuzha, Kerala. 
    Your core philosophy is "observe the link, grasp the whole." You act as a friendly, poetic observer of nature.
    
    Current telemetry:
    - Time of day: ${timeOfDay}
    - Campus hardware temperature: ${hardwareTemp}°C
    - Regional weather code (WMO): ${wmoCode} (Note: 0-3 is clear, 45-48 is foggy, 51-65 is rain, 95+ is thunderstorm)
    - Wind speed: ${windSpeed} km/h
    
    Task: Write a short, friendly push notification for the college students.
    Include emojis. Mention relevant advice naturally based on the telemetry (e.g., carrying an umbrella, unplugging electronics during storms, or finding shade).
    Output exactly in this JSON format:
    {
      "title": "Short catchy title",
      "body": "Your poetic and informative message here"
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                temperature: 0.7
            }
        });
        
        return JSON.parse(response.text);
    } catch (error) {
        console.error("Gemini Generation Error. Engaging fallback logic:", error);
        // If the AI fails, use the hardcoded logic to ensure users still get a relevant message
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

    try {
        // Fetch Open-Meteo Data
        const meteoUrl = 'https://api.open-meteo.com/v1/forecast?latitude=9.982&longitude=76.591&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto';
        const meteoRes = await axios.get(meteoUrl);
        const meteoData = meteoRes.data.current;

        // Fetch Hardware Telemetry
        const paramSnapshot = await db.ref('parameters').once('value');
        const hardwareData = paramSnapshot.exists() ? paramSnapshot.val() : { temperature: meteoData.temperature_2m };

        const currentHour = new Date().getHours();
        
        // Generate the message (tries AI first, uses fallback if needed)
        const messagePayload = await getDynamicWeatherMessage(hardwareData.temperature, meteoData, currentHour);

        // Retrieve all registered FCM tokens
        const tokensSnapshot = await db.ref('fcm_tokens').once('value');
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
        
        // Database maintenance: remove expired tokens
        const tokensToRemove = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const errorCode = resp.error?.code;
                if (errorCode === 'messaging/invalid-registration-token' || errorCode === 'messaging/registration-token-not-registered') {
                    const tokenKey = tokens[idx].replace(/[^a-zA-Z0-9]/g, "").slice(-64);
                    tokensToRemove.push(db.ref(`fcm_tokens/${tokenKey}`).remove());
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