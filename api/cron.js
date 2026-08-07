import admin from 'firebase-admin';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

// 1. Initialize Firebase Admin
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

// 2. Initialize Gemini API Client
const ai = new GoogleGenAI({ 
    apiKey: process.env.GEMINI_API_KEY 
});

// 3. Clean, Classy Fallback Generator (Max 2 Sentences, Zero Jargon)
function getFallbackWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.current ? meteoData.current.weather_code : meteoData.weather_code;
    const isExtreme = [65, 67, 82, 86, 95, 96, 97, 99].includes(wmoCode);
    const isRain = [51, 53, 55, 61, 63, 80, 81].includes(wmoCode);

    let greeting = "Good morning";
    if (currentHour >= 12 && currentHour < 17) greeting = "Good afternoon";
    else if (currentHour >= 17) greeting = "Good evening";

    if (isExtreme) {
        return {
            title: "URGENT WEATHER ALERT 🚨",
            body: "Heavy storm conditions are active near campus. Please stay indoors and keep safe."
        };
    }
    if (isRain) {
        return {
            title: `${greeting} ☔`,
            body: "Rains are falling across campus today. Remember your umbrella and travel safely."
        };
    }
    if (hardwareTemp >= 34) {
        return {
            title: `${greeting} ☀️`,
            body: "A warm and sunlit day ahead. Keep water nearby and stay hydrated."
        };
    }
    return {
        title: `${greeting} 🍃`,
        body: "The skies are calm and gentle today. Wishing you a peaceful day on campus."
    };
}

// 4. Dynamic AI Generation (Punchy, Poetic, Classy)
async function getDynamicWeatherMessage(hardwareTemp, meteoData, currentHour, isScheduledSlot) {
    const currentWmo = meteoData.current.weather_code;
    const windSpeed = meteoData.current.wind_speed_10m;

    let timeLabel = "Evening";
    if (currentHour === 6) timeLabel = "Early Morning Predictive";
    else if (currentHour === 9) timeLabel = "Mid-Morning";
    else if (currentHour === 13) timeLabel = "Afternoon";

    const dailyRain = meteoData.daily?.precipitation_sum || [];
    let pastRainSum = 0;
    for (let i = 0; i < Math.min(4, dailyRain.length); i++) {
        if (dailyRain[i]) pastRainSum += dailyRain[i];
    }

    const isSevereCurrent = [65, 67, 82, 86, 95, 96, 97, 99].includes(currentWmo) || windSpeed > 40;
    const isMultiDayHeavyRain = pastRainSum > 50 && (isSevereCurrent || [61, 63].includes(currentWmo));
    const isRainy = [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(currentWmo);
    const isHot = hardwareTemp >= 34 || meteoData.current.temperature_2m >= 34;

    let prompt = `
    You are 'Zephyrus', a classy, poetic, and refined companion for students at Nirmala College, Muvattupuzha.
    
    CURRENT TELEMETRY:
    - Slot: ${timeLabel} (Hour: ${currentHour})
    - Temp: ${hardwareTemp}°C
    - WMO Weather Code: ${currentWmo}
    - Multi-Day Rain Sum: ${pastRainSum.toFixed(1)} mm
    
    STRICT FORMAT & STYLE RULES:
    1. MAXIMUM LENGTH: EXACTLY 1 OR 2 SENTENCES ONLY. Short, punchy, and classy words.
    2. NO SCIENCE JARGON: Do NOT use words like "physics", "thermodynamics", "condensation", "molecules", "entropy", or "telemetry".
    3. GREETINGS: If scheduled, start with an elegant greeting matching the time slot (e.g., "Good morning", "Good afternoon", "Good evening").
    4. PREDICTIVE MORNING (6:00 AM Slot): Give an early predictive greeting forecasting the day's need (e.g., grab an umbrella for rain, or drink water for heat).
    5. POETIC TONE FOR GOOD WEATHER: Use brief, beautiful, poetic phrasing when weather is clear/calm.
    6. PRACTICAL CARE: 
       - If Rain: Remind to carry an umbrella, raincoat, or travel safely.
       - If Hot/Sunny: Remind to carry water and stay hydrated.
       - If Severe/Flood: Urge them to stay safe indoors and avoid flooded roads.
    
    Output EXACTLY in this JSON format:
    {
      "title": "Classy short title with emoji",
      "body": "Maximum two short, punchy sentences here."
    }`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                temperature: (isSevereCurrent || isMultiDayHeavyRain) ? 0.2 : 0.8
            }
        });
        return JSON.parse(response.text);
    } catch (error) {
        console.error("Gemini Generation Error:", error);
        return getFallbackWeatherMessage(hardwareTemp, meteoData, currentHour);
    }
}

// 5. Main Cron Handler
export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const now = new Date();
    const localString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const localDate = new Date(localString);
    const currentHour = localDate.getHours();

    // STRICT QUIET HOURS: 9:00 PM (21) to 5:59 AM. 
    // Notifications are only allowed from 6:00 AM to 8:59 PM.
    if (currentHour >= 21 || currentHour < 6) {
        console.log(`Quiet hours active (Hour: ${currentHour}). Skipped.`);
        return res.status(200).json({ message: "Quiet hours active. Notifications skipped." });
    }

    try {
        const meteoUrl = 'https://api.open-meteo.com/v1/forecast?latitude=9.982&longitude=76.591&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,precipitation_sum&past_days=3&forecast_days=1&timezone=auto';
        const meteoRes = await axios.get(meteoUrl);
        const meteoData = meteoRes.data;
        const currentWmo = meteoData.current.weather_code;

        const paramSnapshot = await db.ref('parameters').once('value');
        const hardwareData = paramSnapshot.exists() ? paramSnapshot.val() : { temperature: meteoData.current.temperature_2m };
        const currentTemp = hardwareData.temperature;

        const lastSnapshot = await db.ref('last_telemetry').once('value');
        const lastTelemetry = lastSnapshot.exists() ? lastSnapshot.val() : null;

        let hoursSinceLastAlert = 999;
        let lastWmo = null;
        let lastIsSevere = false;

        if (lastTelemetry) {
            hoursSinceLastAlert = (Date.now() - (lastTelemetry.timestamp || 0)) / (1000 * 60 * 60);
            lastWmo = lastTelemetry.weather_code;
            lastIsSevere = lastTelemetry.is_severe || false;
        }

        // Targeted Schedule Hours: 6 AM, 9 AM, 1 PM (13), 6 PM (18)
        const isScheduledSlot = [6, 9, 13, 18].includes(currentHour);
        const isSevereCurrent = [65, 67, 82, 86, 95, 96, 97, 99].includes(currentWmo) || meteoData.current.wind_speed_10m > 40;
        
        const isSuddenShift = (lastWmo !== null) && (currentWmo !== lastWmo) && Math.abs(currentWmo - lastWmo) >= 10;
        const isNewSevereEvent = isSevereCurrent && !lastIsSevere;

        let shouldSendAlert = false;
        let triggerReason = "";

        // GATEKEEPER LOGIC
        // 1. Is it a targeted hour AND has it been at least 2 hours since the last message?
        if (isScheduledSlot && hoursSinceLastAlert >= 2) {
            shouldSendAlert = true;
            triggerReason = `Scheduled Daily Greeting Slot (${currentHour}:00)`;
        } 
        // 2. Is there a sudden severe storm AND has it been at least 1 hour since the last message?
        else if ((isNewSevereEvent || isSuddenShift) && hoursSinceLastAlert >= 1) {
            shouldSendAlert = true;
            triggerReason = "Sudden Severe Weather Change";
        } 
        // 3. Otherwise, the cron is silently ignored.
        else {
            return res.status(200).json({ 
                message: 'Conditions not met or cooldown active. Suppressed.', 
                currentHour, 
                currentWmo 
            });
        }

        console.log(`Triggering push notification based on: ${triggerReason}`);

        const messagePayload = await getDynamicWeatherMessage(currentTemp, meteoData, currentHour, isScheduledSlot);

        const tokensSnapshot = await db.ref('tokens').once('value');
        if (!tokensSnapshot.exists()) return res.status(200).json({ message: 'No subscribers found. Skipped.' });

        const tokens = [];
        tokensSnapshot.forEach((child) => tokens.push(child.val().token));

        const fcmMessage = {
            notification: {
                title: messagePayload.title.includes("URGENT") || messagePayload.title.includes("ALERT") ? messagePayload.title : `Zephyrus: ${messagePayload.title}`, 
                body: messagePayload.body
            },
            webpush: {
                notification: {
                    icon: "https://zephyrus-core.vercel.app/zephyrus-logo.png?v=4" 
                }
            },
            tokens: tokens
        };

        const response = await messaging.sendEachForMulticast(fcmMessage);

        await db.ref('last_telemetry').set({
            temperature: currentTemp,
            weather_code: currentWmo,
            is_severe: isSevereCurrent,
            timestamp: Date.now()
        });

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
            triggerReason,
            ai_title: messagePayload.title,
            sentCount: response.successCount,
            removedCount: tokensToRemove.length
        });

    } catch (error) {
        console.error("Cron Execution Error:", error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
