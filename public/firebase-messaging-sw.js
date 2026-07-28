importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// Initialize Firebase inside the Service Worker
firebase.initializeApp({
    apiKey: "AIzaSyCLHONONZskj2xfmom9Vt5UBSfMwpWazGc",
    authDomain: "zephyrus-f1a79.firebaseapp.com",
    databaseURL: "https://zephyrus-f1a79-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "zephyrus-f1a79",
    storageBucket: "zephyrus-f1a79.firebasestorage.app",
    messagingSenderId: "972646489913",
    appId: "1:972646489913:web:6007af6811635b02b352e8"
});

const messaging = firebase.messaging();

// Handle notification display when the browser window is closed or in background
messaging.onBackgroundMessage((payload) => {
    const notificationTitle = payload.notification?.title || "Zephyrus Core Alert";
    const notificationOptions = {
        body: payload.notification?.body || "New meteorological update recorded.",
        icon: "/logo.webp"
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});