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
        return res.json({ connected: false });
      }

      const userData = userDoc.data();
      res.json({
        connected: userData.telegramConnected || false,
        telegramUsername: userData.telegramUsername || '',
        telegramFirstName: userData.telegramFirstName || ''
      });
    } else {
      // Check memory storage
      const session = Array.from(userSessions.values()).find(s => s.userId === userId && s.connected);
      res.json({
        connected: !!session,
        telegramUsername: session?.telegramUsername || '',
        telegramFirstName: session?.telegramFirstName || ''
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

        // Link Telegram account to app user
        await db.collection('users').doc(appUserId).set({
          telegramConnected: true,
          telegramUserId: telegramUserId,
          telegramChatId: chatId.toString(),
          telegramUsername: msg.from.username || '',
          telegramFirstName: userName,
          telegramConnectedAt: admin.firestore.FieldValue.serverTimestamp()
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
    `🤖 Hesabay AI Bot - Help\n\n` +
    `📱 Commands:\n` +
    `/start - Connect your Hesabay account\n` +
    `/help - Show this help\n` +
    `/disconnect - Disconnect your account\n\n` +
    `💬 Just send any message to chat with me!\n\n` +
    `Made by Baitullah Rohani 💙`
  );
});

// Handle /disconnect command
bot.onText(/\/disconnect/, async (msg) => {
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
        telegramFirstName: admin.firestore.FieldValue.delete()
      });
    } else {
      // Memory storage
      const session = Array.from(userSessions.entries()).find(([_, s]) => s.telegramUserId === telegramUserId);
      if (session) {
        userSessions.delete(session[0]);
      }
    }

    await bot.sendMessage(chatId, 
      `✅ Disconnected from Hesabay.\n\n` +
      `You can reconnect anytime from the Hesabay app.`
    );
  } catch (error) {
    console.error('❌ Error disconnecting:', error);
    await bot.sendMessage(chatId, `❌ Error disconnecting. Please try again.`);
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

// Handle all text messages
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) {
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

    if (db) {
      const usersSnapshot = await db.collection('users')
        .where('telegramUserId', '==', telegramUserId)
        .limit(1)
        .get();

      if (usersSnapshot.empty) {
        await bot.sendMessage(chatId, 
          `⚠️ Please connect your Hesabay account first!\n\n` +
          `Use /start with a connection token from the Hesabay app.`
        );
        return;
      }

      appUserId = usersSnapshot.docs[0].id;

      // Get chat history from Firebase
      const chatRef = db.collection('users').doc(appUserId).collection('telegramChats').doc('main');
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
      const chatRef = db.collection('users').doc(appUserId).collection('telegramChats').doc('main');
      await chatRef.set({
        messages: chatHistory.slice(-20), // Keep last 20 messages
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessage: aiResponse
      }, { merge: true });
    } else {
      chatHistories.set(appUserId, chatHistory.slice(-20));
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

