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

// 3. Robust Fallback Generator
function getFallbackWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const isNight = currentHour >= 19 || currentHour < 5;
    const isMorning = currentHour >= 5 && currentHour < 12;
    const isExtremeWeather = [65, 67, 82, 86, 95, 96, 97, 99].includes(wmoCode) || windSpeed > 40;

    let title = "Zephyrus Core";
    let body = "";

    if (isExtremeWeather) {
        title = "URGENT WEATHER ALERT 🚨";
        body = "Extreme weather conditions detected on campus. Please prioritize safety, avoid unnecessary travel, and stay indoors.";
    } else if (wmoCode >= 51 && wmoCode <= 64) {
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

// 4. Dynamic AI Generation (With Emergency Override)
async function getDynamicWeatherMessage(hardwareTemp, meteoData, currentHour) {
    const wmoCode = meteoData.weather_code;
    const windSpeed = meteoData.wind_speed_10m;
    const timeOfDay = currentHour >= 19 || currentHour < 5 ? "night" : (currentHour >= 5 && currentHour < 12 ? "morning" : "afternoon/evening");

    const isExtremeWeather = [65, 67, 82, 86, 95, 96, 97, 99].includes(wmoCode) || windSpeed > 40;
    let prompt = "";

    if (isExtremeWeather) {
        prompt = `
        You are 'Zephyrus', the campus weather monitor for Nirmala College in Muvattupuzha, Kerala.
        CRITICAL ALERT: Extreme weather is currently detected. 
        - WMO Code: ${wmoCode} (indicates severe heavy rain, thunderstorms, or extreme conditions)
        - Wind speed: ${windSpeed} km/h
        
        Task: Write a serious, urgent push notification. Drop all sarcasm and philosophical jokes. Warn students of potential hazards like waterlogging, severe lightning, or difficult travel conditions. Keep it brief and emphasize safety.
        
        Output exactly in this JSON format:
        {
          "title": "URGENT WEATHER ALERT 🚨",
          "body": "Your brief safety warning here"
        }
        `;
    } else {
        prompt = `
        You are the voice of 'Zephyrus', a witty, philosophical, and slightly sarcastic physics-loving weather core monitoring the campus of Nirmala College in Muvattupuzha, Kerala. 
        Your core philosophy is "observe the link, grasp the whole." You blend poetic literary reflections with comedic remarks, sarcastic physics concepts, and warm AI companion energy.
        
        Current telemetry:
        - Time of day: ${timeOfDay}
        - Campus hardware temperature: ${hardwareTemp}°C
        - Regional weather code (WMO): ${wmoCode} 
        - Wind speed: ${windSpeed} km/h
        
        Task: Write a short, highly engaging push notification for college students. Inject humor, a touch of sarcastic physics or literary flair, emojis, and friendly advice.
        
        Output exactly in this JSON format:
        {
          "title": "Witty or poetic title with an emoji",
          "body": "Your clever, atmospheric message here"
        }
        `;
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                temperature: isExtremeWeather ? 0.3 : 0.85 
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
        return res.status(200).json({ message: "Quiet hours active. Notifications skipped." });
    }

    try {
        const meteoUrl = 'https://api.open-meteo.com/v1/forecast?latitude=9.982&longitude=76.591&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto';
        const meteoRes = await axios.get(meteoUrl);
        const meteoData = meteoRes.data.current;

        const paramSnapshot = await db.ref('parameters').once('value');
        const hardwareData = paramSnapshot.exists() ? paramSnapshot.val() : { temperature: meteoData.temperature_2m };

        const currentTemp = hardwareData.temperature;
        const currentWmo = meteoData.weather_code;

        // ==========================================
        // NOTIFICATION TRIGGER LOGIC
        // ==========================================
        const lastSnapshot = await db.ref('last_telemetry').once('value');
        const lastTelemetry = lastSnapshot.exists() ? lastSnapshot.val() : null;

        let tempDiff = 0;
        let wmoChanged = false;
        let hoursSinceLastAlert = 0;

        if (lastTelemetry) {
            tempDiff = Math.abs(currentTemp - lastTelemetry.temperature);
            wmoChanged = currentWmo !== lastTelemetry.weather_code;
            hoursSinceLastAlert = (Date.now() - (lastTelemetry.timestamp || 0)) / (1000 * 60 * 60);
        }

        const isScheduledSlot = [8, 13, 18].includes(currentHour);
        const isExtremeWeather = [65, 67, 82, 86, 95, 96, 97, 99].includes(currentWmo) || meteoData.wind_speed_10m > 40;

        let shouldSendAlert = false;
        let triggerReason = "";

        // Send alert if severe conditions exist (and it's a new WMO code or it has been > 2 hours since last ping)
        if (isExtremeWeather && (wmoChanged || hoursSinceLastAlert > 2)) {
            shouldSendAlert = true;
            triggerReason = "Extreme Weather Detected";
        } 
        // Send scheduled daily updates
        else if (isScheduledSlot && hoursSinceLastAlert > 1) { 
            shouldSendAlert = true;
            triggerReason = "Scheduled Daily Update";
        } 
        // Send if delta conditions are met (temp changed, WMO changed, or 8 hours passed)
        else if (tempDiff >= 2 || wmoChanged || hoursSinceLastAlert >= 8) {
            shouldSendAlert = true;
            triggerReason = "Delta Change or Heartbeat";
        }

        if (!shouldSendAlert) {
            console.log(`Weather static and off-schedule. WMO: ${currentWmo}. Skipping notification.`);
            return res.status(200).json({ message: 'Telemetry static. Alert suppressed.', currentHour, currentWmo });
        }
        
        console.log(`Triggering notification based on: ${triggerReason}`);

        const messagePayload = await getDynamicWeatherMessage(currentTemp, meteoData, currentHour);

        const tokensSnapshot = await db.ref('tokens').once('value');
        if (!tokensSnapshot.exists()) return res.status(200).json({ message: 'No subscribers found. Skipped.' });

        const tokens = [];
        tokensSnapshot.forEach((child) => tokens.push(child.val().token));

        const fcmMessage = {
            notification: {
                title: messagePayload.title.includes("URGENT") ? messagePayload.title : `Zephyrus: ${messagePayload.title}`, 
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
