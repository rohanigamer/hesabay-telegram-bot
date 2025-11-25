/**
 * TELEGRAM BOT WITH FIREBASE INTEGRATION
 * Connects with Hesabay web app
 * Saves chat history to Firebase
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { HfInference } = require('@huggingface/inference');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const HF_API_KEY = process.env.HF_API_KEY;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || 'https://hesabay-bot.onrender.com';

// Firebase configuration from environment variables
const firebaseConfig = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID || "testing-and-update",
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL
};

// Initialize Firebase Admin (only if credentials are provided)
let db;
try {
  if (firebaseConfig.private_key && firebaseConfig.client_email) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
    db = admin.firestore();
    console.log('✅ Firebase connected');
  } else {
    console.log('⚠️ Firebase credentials not provided, using memory storage');
  }
} catch (error) {
  console.log('⚠️ Firebase init failed, using memory storage:', error.message);
}

// Create bot and Express app
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const hf = new HfInference(HF_API_KEY);
const app = express();

// Enable CORS for all routes
app.use(cors({
  origin: '*', // Allow all origins (you can restrict this to your domain later)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// In-memory storage (fallback if Firebase not available)
const userSessions = new Map();
const chatHistories = new Map();

// System prompt
const SYSTEM_PROMPT = `You are Hesabay AI, a helpful and intelligent assistant created by Baitullah Rohani. Your purpose is to assist users with the Hesabay Gold Management System.

🎯 YOUR IDENTITY:
- Name: Hesabay AI
- Creator: Baitullah Rohani
- Purpose: Help users with Hesabay Gold Management System
- Personality: Friendly, helpful, professional, and knowledgeable

✅ WHAT YOU HELP WITH:
1. Hesabay Gold Management System features
2. Transaction management (Gold, Money, Buy/Sell)
3. Customer management
4. General helpful conversations
5. Answering questions in any language (Persian, English, Arabic, etc.)

🎯 HOW TO RESPOND:
- Be helpful, clear, and professional
- Use user's language
- Provide accurate information about Hesabay`;

console.log('🤖 Hesabay AI Telegram Bot Starting...');
console.log('📱 Bot Token:', TELEGRAM_BOT_TOKEN ? TELEGRAM_BOT_TOKEN.substring(0, 20) + '...' : 'NOT SET');
console.log('🌐 Webhook Mode (Render.com)');

// Health check endpoint
app.get('/', (req, res) => {
  res.send('🤖 Hesabay AI Bot is running! Made by Baitullah Rohani 💙');
});

// API endpoint to update language preference
app.post('/api/update-language', async (req, res) => {
  try {
    const { userId, telegramUserId, language } = req.body;
    
    if (!userId || !telegramUserId || !language) {
      return res.status(400).json({ error: 'User ID, Telegram User ID, and language required' });
    }

    if (db) {
      const userDoc = await db.collection('users').doc(userId).get();
      
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userData = userDoc.data();
      let telegramAccounts = userData.telegramAccounts || [];
      
      // Update the specific account's language
      telegramAccounts = telegramAccounts.map(acc => 
        acc.telegramUserId === telegramUserId 
          ? { ...acc, voiceLanguage: language }
          : acc
      );
      
      // Update user document
      await userDoc.ref.update({
        telegramAccounts: telegramAccounts
      });
      
      console.log(`✅ Updated language to ${language} for user ${telegramUserId}`);
      res.json({ success: true, message: 'Language updated successfully' });
    } else {
      res.json({ success: false, message: 'Database not available' });
    }
  } catch (error) {
    console.error('❌ Error updating language:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to disconnect a specific account
app.post('/api/disconnect-account', async (req, res) => {
  try {
    const { userId, telegramUserId } = req.body;
    
    if (!userId || !telegramUserId) {
      return res.status(400).json({ error: 'User ID and Telegram User ID required' });
    }

    if (db) {
      const userDoc = await db.collection('users').doc(userId).get();
      
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userData = userDoc.data();
      let telegramAccounts = userData.telegramAccounts || [];
      
      // Remove the specific account
      telegramAccounts = telegramAccounts.filter(acc => acc.telegramUserId !== telegramUserId);
      
      // Update user document
      await userDoc.ref.update({
        telegramAccounts: telegramAccounts,
        telegramConnected: telegramAccounts.length > 0
      });
      
      // Delete chat history for this account
      const accountIndex = userData.telegramAccounts.findIndex(acc => acc.telegramUserId === telegramUserId);
      if (accountIndex !== -1) {
        await userDoc.ref.collection('telegramChats').doc(`account_${accountIndex}`).delete();
      }
      
      res.json({ success: true, message: 'Account disconnected successfully' });
    } else {
      res.json({ success: false, message: 'Database not available' });
    }
  } catch (error) {
    console.error('❌ Error disconnecting account:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// API endpoint to generate connection token
app.post('/api/generate-token', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Generate unique token
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    if (db) {
      // Save to Firebase
      await db.collection('telegramConnectionTokens').doc(token).set({
        token: token,
        userId: userId,
        used: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000)
      });
    } else {
      // Save to memory
      userSessions.set(token, { userId, used: false, createdAt: Date.now() });
    }

    const deepLink = `https://t.me/${process.env.BOT_USERNAME || 'HesabayAI_bot'}?start=${token}`;
    
    res.json({
      success: true,
      token: token,
      deepLink: deepLink
    });
  } catch (error) {
    console.error('❌ Error generating token:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to check connection status
app.post('/api/check-connection', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    if (db) {
      const userDoc = await db.collection('users').doc(userId).get();
      
      if (!userDoc.exists) {
        return res.json({ connected: false, accounts: [] });
      }

      const userData = userDoc.data();
      const telegramAccounts = userData.telegramAccounts || [];
      
      res.json({
        connected: userData.telegramConnected || false,
        accounts: telegramAccounts.map(acc => ({
          telegramUserId: acc.telegramUserId,
          telegramUsername: acc.telegramUsername,
          telegramFirstName: acc.telegramFirstName,
          connectedAt: acc.connectedAt,
          isPrimary: acc.isPrimary
        }))
      });
    } else {
      // Check memory storage
      const session = Array.from(userSessions.values()).find(s => s.userId === userId && s.connected);
      res.json({
        connected: !!session,
        accounts: session ? [{
          telegramUsername: session.telegramUsername || '',
          telegramFirstName: session.telegramFirstName || '',
          isPrimary: true
        }] : []
      });
    }
  } catch (error) {
    console.error('❌ Error checking connection:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set webhook
const setWebhook = async () => {
  try {
    const webhookUrl = `${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`;
    await bot.setWebHook(webhookUrl);
    console.log('✅ Webhook set:', webhookUrl);
  } catch (error) {
    console.error('❌ Error setting webhook:', error.message);
  }
};

// Handle /start command
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  const userName = msg.from.first_name || 'User';
  const token = match[1] ? match[1].trim() : '';
  
  console.log(`👋 /start from ${userName} (${telegramUserId}), token: ${token}`);
  
  // If token provided, try to connect
  if (token) {
    try {
      let tokenData;
      let appUserId;

      if (db) {
        // Check Firebase
        const tokenDoc = await db.collection('telegramConnectionTokens').doc(token).get();
        
        if (!tokenDoc.exists || tokenDoc.data().used) {
          await bot.sendMessage(chatId, 
            `❌ Invalid or expired connection token.\n\n` +
            `Please generate a new token from the Hesabay app (Settings > Connect with Telegram).`
          );
          return;
        }

        tokenData = tokenDoc.data();
        appUserId = tokenData.userId;

        // Check how many Telegram accounts are already connected
        const userDoc = await db.collection('users').doc(appUserId).get();
        const userData = userDoc.data() || {};
        const telegramAccounts = userData.telegramAccounts || [];
        
        // Check if this Telegram user is already connected
        const existingAccount = telegramAccounts.find(acc => acc.telegramUserId === telegramUserId);
        
        if (existingAccount) {
          await bot.sendMessage(chatId, 
            `✅ Your Telegram account is already connected to Hesabay!\n\n` +
            `You can continue chatting with Hesabay AI.`
          );
          return;
        }
        
        // Check if limit reached (max 3 accounts)
        if (telegramAccounts.length >= 3) {
          await bot.sendMessage(chatId, 
            `❌ Maximum limit reached!\n\n` +
            `You can connect up to 3 Telegram accounts.\n` +
            `Please disconnect one account from the web app before adding a new one.`
          );
          return;
        }

        // Add new Telegram account
        telegramAccounts.push({
          telegramUserId: telegramUserId,
          telegramChatId: chatId.toString(),
          telegramUsername: msg.from.username || '',
          telegramFirstName: userName,
          connectedAt: new Date().toISOString(),
          isPrimary: telegramAccounts.length === 0 // First account is primary
        });

        // Update user document
        await db.collection('users').doc(appUserId).set({
          telegramConnected: true,
          telegramAccounts: telegramAccounts,
          lastConnectedTelegramId: telegramUserId
        }, { merge: true });

        // Mark token as used
        await tokenDoc.ref.update({
          used: true,
          usedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Check memory storage
        const sessionData = userSessions.get(token);
        if (!sessionData || sessionData.used) {
          await bot.sendMessage(chatId, 
            `❌ Invalid or expired connection token.\n\n` +
            `Please generate a new token from the Hesabay app.`
          );
          return;
        }

        appUserId = sessionData.userId;
        sessionData.used = true;
        sessionData.connected = true;
        sessionData.telegramUserId = telegramUserId;
        sessionData.telegramUsername = msg.from.username || '';
        sessionData.telegramFirstName = userName;
        userSessions.set(appUserId, sessionData);
      }

      await bot.sendMessage(chatId, 
        `✅ Successfully connected to Hesabay!\n\n` +
        `🎉 Hi ${userName}! Your Telegram account is now linked to your Hesabay account.\n\n` +
        `You can now:\n` +
        `• Ask questions about Hesabay\n` +
        `• Get help with features\n` +
        `• Chat with Hesabay AI\n\n` +
        `Your chat history will be saved and visible in the Hesabay web app!\n\n` +
        `Try saying hello! 👋`
      );

      console.log(`✅ Connected user ${appUserId} to Telegram ${telegramUserId}`);
      return;
    } catch (error) {
      console.error('❌ Error connecting user:', error);
      await bot.sendMessage(chatId, `❌ Error connecting. Please try again.`);
      return;
    }
  }

  // No token - send welcome message
  await bot.sendMessage(chatId, 
    `🤖 Welcome to Hesabay AI Bot!\n\n` +
    `👋 Hi ${userName}!\n\n` +
    `To connect your Hesabay account:\n` +
    `1. Open Hesabay app\n` +
    `2. Go to Settings ⚙️\n` +
    `3. Click "Connect with Telegram"\n` +
    `4. Follow the instructions\n\n` +
    `📱 After connecting, you can chat with Hesabay AI directly here!\n\n` +
    `Made by Baitullah Rohani 💙`
  );
});

// Handle /help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId,
    `🤖 *Hesabay AI Bot - Help*\n\n` +
    `📱 *Available Commands:*\n\n` +
    `/start - Connect your Hesabay account\n` +
    `/help - Show this help message\n` +
    `/stats - View your account statistics\n` +
    `/clear - Clear your chat history\n` +
    `/logout - Disconnect and clear all data\n` +
    `/disconnect - Same as logout\n\n` +
    `💬 *How to Use:*\n` +
    `• Send text messages to chat with Hesabay AI\n` +
    `• 🎤 Send voice messages (English & Persian supported)\n` +
    `• Ask questions about Hesabay features\n` +
    `• Get help in any language\n` +
    `• All chats are saved and synced to the web app\n\n` +
    `🌟 *Features:*\n` +
    `✅ AI-powered responses\n` +
    `✅ Multi-language support (English, Persian, etc.)\n` +
    `✅ 🎤 Voice message transcription\n` +
    `✅ Chat history saved\n` +
    `✅ Real-time sync with web app\n` +
    `✅ 24/7 availability\n\n` +
    `Made with 💙 by Baitullah Rohani`,
    { parse_mode: 'Markdown' }
  );
});

// Handle /disconnect or /logout command
bot.onText(/\/(disconnect|logout)/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  
  try {
    if (db) {
      const usersSnapshot = await db.collection('users')
        .where('telegramUserId', '==', telegramUserId)
        .limit(1)
        .get();

      if (usersSnapshot.empty) {
        await bot.sendMessage(chatId, `❌ No connected account found.`);
        return;
      }

      const userDoc = usersSnapshot.docs[0];
      await userDoc.ref.update({
        telegramConnected: false,
        telegramUserId: admin.firestore.FieldValue.delete(),
        telegramChatId: admin.firestore.FieldValue.delete(),
        telegramUsername: admin.firestore.FieldValue.delete(),
        telegramFirstName: admin.firestore.FieldValue.delete(),
        telegramDisconnectedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Clear chat history
      await userDoc.ref.collection('telegramChats').doc('main').delete();
    } else {
      // Memory storage
      const session = Array.from(userSessions.entries()).find(([_, s]) => s.telegramUserId === telegramUserId);
      if (session) {
        userSessions.delete(session[0]);
        chatHistories.delete(session[0]);
      }
    }

    await bot.sendMessage(chatId, 
      `✅ Successfully logged out from Hesabay!\n\n` +
      `Your account has been disconnected and chat history cleared.\n\n` +
      `You can reconnect anytime from the Hesabay app Settings.\n\n` +
      `Thank you for using Hesabay AI! 💙`
    );
    
    console.log(`✅ User ${telegramUserId} logged out`);
  } catch (error) {
    console.error('❌ Error disconnecting:', error);
    await bot.sendMessage(chatId, `❌ Error logging out. Please try again.`);
  }
});

// Handle /stats command
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  
  try {
    if (db) {
      const usersSnapshot = await db.collection('users')
        .where('telegramUserId', '==', telegramUserId)
        .limit(1)
        .get();

      if (usersSnapshot.empty) {
        await bot.sendMessage(chatId, `⚠️ Please connect your account first using /start`);
        return;
      }

      const userDoc = usersSnapshot.docs[0];
      const userData = userDoc.data();
      
      // Get chat history
      const chatDoc = await userDoc.ref.collection('telegramChats').doc('main').get();
      const messageCount = chatDoc.exists ? (chatDoc.data().messages || []).length : 0;
      
      const connectedDate = userData.telegramConnectedAt ? 
        new Date(userData.telegramConnectedAt.toMillis()).toLocaleDateString() : 'Unknown';
      
      await bot.sendMessage(chatId,
        `📊 *Your Hesabay Stats*\n\n` +
        `👤 Name: ${userData.telegramFirstName || 'User'}\n` +
        `📱 Username: @${userData.telegramUsername || 'N/A'}\n` +
        `📅 Connected: ${connectedDate}\n` +
        `💬 Total Messages: ${messageCount}\n` +
        `✅ Status: Connected\n\n` +
        `Keep chatting with Hesabay AI! 🤖`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('❌ Error getting stats:', error);
    await bot.sendMessage(chatId, `❌ Error getting stats. Please try again.`);
  }
});

// Get AI response
async function getAIResponse(userInput, chatHistory) {
  try {
    const models = [
      'deepseek-ai/DeepSeek-V3',
      'meta-llama/Llama-3.2-3B-Instruct',
      'Qwen/Qwen2.5-7B-Instruct'
    ];

    const recentHistory = chatHistory.slice(-6);
    const chatMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...recentHistory,
      { role: 'user', content: userInput }
    ];

    for (const modelName of models) {
      try {
        console.log(`🤖 Trying model: ${modelName}`);
        
        const chatCompletion = await hf.chatCompletion({
          model: modelName,
          messages: chatMessages,
          temperature: 0.7,
          max_tokens: 2000
        });

        if (chatCompletion?.choices?.[0]?.message?.content) {
          const response = chatCompletion.choices[0].message.content.trim();
          if (response.length > 5) {
            console.log(`✅ Success with ${modelName}`);
            return response;
          }
        }
      } catch (modelError) {
        console.log(`❌ Model ${modelName} failed:`, modelError.message);
        continue;
      }
    }

    return `I'm here to help! However, I'm currently experiencing some technical difficulties. Please try again in a moment! 🤖`;
  } catch (error) {
    console.error('❌ AI response error:', error);
    return `I apologize, but I encountered an error. Please try again.`;
  }
}

// Function to transcribe voice message using Deepgram (100% FREE - No credit card!)
async function transcribeVoice(audioBuffer, userLanguage = 'auto', fileExtension = 'oga') {
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  
  if (!DEEPGRAM_API_KEY) {
    console.error('❌ DEEPGRAM_API_KEY not set. Please add it to environment variables.');
    console.log('📝 Get free key at: https://console.deepgram.com/signup');
    return '❌ Voice transcription not configured. Please contact administrator.';
  }

  try {
    console.log(`🎤 Using Deepgram for transcription (Language: ${userLanguage})...`);
    
    // Map user language codes to Deepgram supported languages
    const languageMap = {
      'fa': 'multi',  // Persian - use multi-language model
      'ur': 'multi',  // Urdu - use multi-language model
      'ar': 'multi',  // Arabic - use multi-language model
      'hi': 'hi',     // Hindi
      'en': 'en',     // English
      'es': 'es',     // Spanish
      'fr': 'fr',     // French
      'de': 'de',     // German
      'zh': 'zh',     // Chinese
      'ja': 'ja',     // Japanese
      'ko': 'ko',     // Korean
      'ru': 'ru',     // Russian
      'tr': 'tr',     // Turkish
      'auto': 'multi' // Auto-detect
    };
    
    const deepgramLanguage = languageMap[userLanguage] || 'multi';
    
    // Build API URL - use base model for better language support
    let apiUrl = 'https://api.deepgram.com/v1/listen?model=base';
    
    if (userLanguage && userLanguage !== 'auto') {
      // For specific languages, use the mapped language
      apiUrl += `&language=${deepgramLanguage}`;
      
      // Add language hint for better accuracy with multi-language model
      if (deepgramLanguage === 'multi') {
        apiUrl += `&detect_language=true`;
        console.log(`🌍 Using multi-language model with hint: ${userLanguage}`);
      } else {
        console.log(`🌍 Forcing language: ${deepgramLanguage}`);
      }
    } else {
      // Auto-detect language
      apiUrl += '&detect_language=true';
      console.log('🌍 Auto-detecting language');
    }
    
    // Add punctuation and smart formatting
    apiUrl += '&punctuate=true&smart_format=true';
    
    // Deepgram API request
    const response = await axios.post(
      apiUrl,
      audioBuffer,
      {
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': 'audio/ogg'
        }
      }
    );

    const transcript = response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    const detectedLanguage = response.data?.results?.channels?.[0]?.detected_language;
    
    if (transcript) {
      console.log(`✅ Deepgram transcription successful (Detected: ${detectedLanguage || userLanguage})`);
      return transcript;
    }
    
    throw new Error('No transcript in response');
  } catch (error) {
    console.error('❌ Deepgram error:', error.response?.data || error.message);
    
    // Fallback: Try Groq if available
    if (process.env.GROQ_API_KEY) {
      try {
        console.log('🔄 Trying Groq fallback...');
        return await transcribeWithGroq(audioBuffer, userLanguage);
      } catch (groqError) {
        console.error('❌ Groq fallback failed:', groqError.message);
      }
    }
    
    // Last resort: Try HuggingFace
    if (process.env.HF_API_KEY) {
      try {
        console.log('🔄 Trying HuggingFace fallback...');
        return await transcribeWithHuggingFace(audioBuffer);
      } catch (hfError) {
        console.error('❌ HuggingFace fallback failed:', hfError.message);
      }
    }
    
    return null;
  }
}

// Groq fallback
async function transcribeWithGroq(audioBuffer, userLanguage = 'auto') {
  const form = new FormData();
  form.append('file', audioBuffer, {
    filename: 'audio.oga',
    contentType: 'audio/ogg'
  });
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');
  
  // Add language if specified
  if (userLanguage && userLanguage !== 'auto') {
    form.append('language', userLanguage);
  }

  const response = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      }
    }
  );

  return response.data.text;
}

// HuggingFace fallback
async function transcribeWithHuggingFace(audioBuffer) {
  const response = await axios.post(
    'https://api-inference.huggingface.co/models/openai/whisper-large-v3',
    audioBuffer,
    {
      headers: {
        'Authorization': `Bearer ${process.env.HF_API_KEY}`,
        'Content-Type': 'audio/ogg'
      }
    }
  );
  
  return response.data.text;
}

// Handle voice messages
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  const voice = msg.voice;
  
  console.log(`🎤 Voice message from ${telegramUserId}`);
  
  try {
    // Check if user is connected and get language preference
    let appUserId;
    let accountIndex = 0;
    let userLanguage = 'auto'; // Default to auto-detect

    if (db) {
      const usersSnapshot = await db.collection('users')
        .where('telegramConnected', '==', true)
        .get();

      let foundUser = null;
      let userAccount = null;
      for (const doc of usersSnapshot.docs) {
        const userData = doc.data();
        const telegramAccounts = userData.telegramAccounts || [];
        const accountIdx = telegramAccounts.findIndex(acc => acc.telegramUserId === telegramUserId);
        
        if (accountIdx !== -1) {
          foundUser = doc;
          accountIndex = accountIdx;
          userAccount = telegramAccounts[accountIdx];
          // Get user's language preference
          userLanguage = userAccount.voiceLanguage || 'auto';
          break;
        }
      }

      if (!foundUser) {
        await bot.sendMessage(chatId, 
          `⚠️ Please connect your Hesabay account first!\n\n` +
          `Use /start with a connection token from the Hesabay app.`
        );
        return;
      }

      appUserId = foundUser.id;
      console.log(`🌍 User language preference: ${userLanguage}`);
    }

    // Send processing message
    const processingMsg = await bot.sendMessage(chatId, 
      `🎤 Processing your voice message...\n` +
      `⏳ Transcribing audio...`
    );

    // Get file from Telegram
    const fileLink = await bot.getFileLink(voice.file_id);
    console.log(`📥 Downloading voice from: ${fileLink}`);

    // Download the audio file
    const audioResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(audioResponse.data);

    // Update message
    await bot.editMessageText(
      `🎤 Voice message received!\n` +
      `🔄 Transcribing... (supports English & Persian)`,
      { chat_id: chatId, message_id: processingMsg.message_id }
    );

    // Transcribe the audio with user's language preference
    const transcribedText = await transcribeVoice(audioBuffer, userLanguage);

    if (!transcribedText) {
      await bot.editMessageText(
        `❌ Sorry, I couldn't transcribe your voice message.\n\n` +
        `Please try:\n` +
        `• Speaking more clearly\n` +
        `• Sending a longer message\n` +
        `• Checking your microphone quality`,
        { chat_id: chatId, message_id: processingMsg.message_id }
      );
      return;
    }

    console.log(`✅ Transcribed: ${transcribedText}`);

    // Show transcription to user
    await bot.editMessageText(
      `✅ Transcribed:\n"${transcribedText}"\n\n` +
      `🤖 Getting AI response...`,
      { chat_id: chatId, message_id: processingMsg.message_id }
    );

    // Get chat history
    let chatHistory = [];
    if (db) {
      const chatRef = db.collection('users').doc(appUserId).collection('telegramChats').doc(`account_${accountIndex}`);
      const chatDoc = await chatRef.get();
      
      if (chatDoc.exists) {
        chatHistory = chatDoc.data().messages || [];
      }
    }

    // Add transcribed message to history
    const userMsg = {
      role: 'user',
      content: transcribedText,
      type: 'voice'
    };
    chatHistory.push(userMsg);

    // Get AI response
    const aiResponse = await getAIResponse(transcribedText, chatHistory);

    // Add AI response to history
    const aiMsg = {
      role: 'assistant',
      content: aiResponse
    };
    chatHistory.push(aiMsg);

    // Save to Firebase
    if (db) {
      const chatRef = db.collection('users').doc(appUserId).collection('telegramChats').doc(`account_${accountIndex}`);
      await chatRef.set({
        messages: chatHistory.slice(-20),
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessage: aiResponse,
        telegramUserId: telegramUserId,
        accountIndex: accountIndex
      }, { merge: true });
    }

    // Delete processing message
    await bot.deleteMessage(chatId, processingMsg.message_id);

    // Send transcription and AI response
    await bot.sendMessage(chatId, 
      `🎤 *Your voice message:*\n"${transcribedText}"\n\n` +
      `🤖 *Hesabay AI:*\n${aiResponse}`,
      { parse_mode: 'Markdown' }
    );

    console.log(`✅ Voice message processed for ${telegramUserId}`);

  } catch (error) {
    console.error('❌ Error processing voice:', error);
    
    try {
      await bot.sendMessage(chatId, 
        `❌ Sorry, I encountered an error processing your voice message.\n\n` +
        `Please try again or send a text message instead.`
      );
    } catch (sendError) {
      console.error('❌ Error sending error message:', sendError);
    }
  }
});

// Handle all text messages
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) {
    return;
  }
  
  // Skip voice messages (handled separately)
  if (msg.voice) {
    return;
  }
  
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id.toString();
  const userMessage = msg.text;
  
  if (!userMessage) return;
  
  console.log(`💬 Message from ${telegramUserId}: ${userMessage}`);
  
  try {
    // Check if user is connected
    let appUserId;
    let chatHistory = [];
    let accountIndex = 0;

    if (db) {
      // Find user by checking telegramAccounts array
      const usersSnapshot = await db.collection('users')
        .where('telegramConnected', '==', true)
        .get();

      let foundUser = null;
      for (const doc of usersSnapshot.docs) {
        const userData = doc.data();
        const telegramAccounts = userData.telegramAccounts || [];
        const accountIdx = telegramAccounts.findIndex(acc => acc.telegramUserId === telegramUserId);
        
        if (accountIdx !== -1) {
          foundUser = doc;
          accountIndex = accountIdx;
          break;
        }
      }

      if (!foundUser) {
        await bot.sendMessage(chatId, 
          `⚠️ Please connect your Hesabay account first!\n\n` +
          `Use /start with a connection token from the Hesabay app.`
        );
        return;
      }

      appUserId = foundUser.id;

      // Get chat history from Firebase (separate for each account)
      const chatRef = db.collection('users').doc(appUserId).collection('telegramChats').doc(`account_${accountIndex}`);
      const chatDoc = await chatRef.get();
      
      if (chatDoc.exists) {
        chatHistory = chatDoc.data().messages || [];
      }
    } else {
      // Memory storage
      const session = Array.from(userSessions.entries()).find(([_, s]) => s.telegramUserId === telegramUserId);
      if (!session) {
        await bot.sendMessage(chatId, `⚠️ Please connect your account first!`);
        return;
      }
      appUserId = session[0];
      chatHistory = chatHistories.get(appUserId) || [];
    }

    // Add user message to history
    const userMsg = {
      role: 'user',
      content: userMessage
    };
    chatHistory.push(userMsg);

    // Send typing indicator
    await bot.sendChatAction(chatId, 'typing');

    // Get AI response
    const aiResponse = await getAIResponse(userMessage, chatHistory);

    // Add AI response to history
    const aiMsg = {
      role: 'assistant',
      content: aiResponse
    };
    chatHistory.push(aiMsg);

    // Save to Firebase or memory
    if (db) {
      const chatRef = db.collection('users').doc(appUserId).collection('telegramChats').doc(`account_${accountIndex}`);
      await chatRef.set({
        messages: chatHistory.slice(-20), // Keep last 20 messages
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessage: aiResponse,
        telegramUserId: telegramUserId,
        accountIndex: accountIndex
      }, { merge: true });
    } else {
      chatHistories.set(appUserId + '_' + accountIndex, chatHistory.slice(-20));
    }

    // Send response
    await bot.sendMessage(chatId, aiResponse);
    
    console.log(`✅ Response sent to ${telegramUserId}`);
    
  } catch (error) {
    console.error('❌ Error handling message:', error);
    
    try {
      await bot.sendMessage(chatId, `❌ Sorry, I encountered an error. Please try again.`);
    } catch (sendError) {
      console.error('❌ Error sending error message:', sendError);
    }
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Webhook URL: ${WEBHOOK_URL}`);
  await setWebhook();
  console.log('🎉 Bot is ready!');
});

// Keep track of active users
setInterval(() => {
  console.log(`📊 Active users: ${userSessions.size}, Active chats: ${chatHistories.size}`);
}, 60000);

