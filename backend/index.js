import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables FIRST
dotenv.config();

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import studyRoutes from './routes/study.js';
import { authenticateSocket } from './middleware/auth.js';
import User from './models/User.js';

// Validate required environment variables
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

const app = express();
const server = createServer(app);

// CORS configuration for production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? [
        process.env.FRONTEND_URL,
        'https://study-with-me-tau.vercel.app',
        /\.vercel\.app$/  // Allow any vercel.app subdomain
      ].filter(Boolean)
    : ["http://localhost:5173", "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
};

const io = new Server(server, {
  cors: corsOptions
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Serve static files (uploaded images)
app.use('/uploads', express.static('uploads'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/studytogether';

console.log('Attempting to connect to MongoDB...');
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
  connectTimeoutMS: 10000, // Give up initial connection after 10s
})
  .then(() => {
    console.log('✅ Connected to MongoDB successfully');
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Continuing without MongoDB (some features may not work)');
    console.log('💡 To fix this:');
    console.log('   1. Install MongoDB locally, OR');
    console.log('   2. Use MongoDB Atlas cloud service, OR');
    console.log('   3. Update MONGODB_URI in .env file');
  });

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/study', studyRoutes);

// Socket.io for real-time features
const activeUsers = new Map();

io.use(authenticateSocket);

io.on('connection', async (socket) => {
  console.log('User connected:', socket.userId);
  
  try {
    // Fetch user with friends from database
    const user = await User.findById(socket.userId).select('friends');
    
    if (!user) {
      console.error('User not found:', socket.userId);
      socket.disconnect();
      return;
    }

    // Store active user
    activeUsers.set(socket.userId, {
      socketId: socket.id,
      studySession: null,
      lastSeen: new Date(),
      friends: user.friends || []
    });

    // Join user to their personal room
    socket.join(`user_${socket.userId}`);

    // Join all friends' rooms so we can notify them when this user comes online/offline
    const friendIds = (user.friends || []).map(friend => friend.toString());
    const currentUserId = socket.userId.toString();
    
    friendIds.forEach(friendId => {
      socket.join(`user_${friendId}`);
    });

    // Notify all friends that this user is now online
    friendIds.forEach(friendId => {
      io.to(`user_${friendId}`).emit('friend_online', {
        userId: currentUserId
      });
    });

    // Send initial online friends list to the connected user
    const onlineFriends = friendIds.filter(id => {
      // Check if friend is online (normalize IDs to strings for comparison)
      return Array.from(activeUsers.keys()).some(key => key.toString() === id);
    });
    socket.emit('online_friends', onlineFriends);

    // Handle study session start
    socket.on('start_study', (data) => {
      const activeUser = activeUsers.get(socket.userId);
      if (activeUser) {
        activeUser.studySession = {
          startTime: new Date(),
          subject: data.subject || 'General Study',
          target: data.target || null
        };
        
        // Notify all friends about study session
        friendIds.forEach(friendId => {
          io.to(`user_${friendId}`).emit('friend_started_studying', {
            userId: currentUserId,
            startTime: activeUser.studySession.startTime,
            subject: activeUser.studySession.subject
          });
        });
      }
    });

    // Handle study session stop
    socket.on('stop_study', () => {
      const activeUser = activeUsers.get(socket.userId);
      if (activeUser && activeUser.studySession) {
        const duration = Date.now() - activeUser.studySession.startTime.getTime();
        
        activeUser.studySession = null;
        
        // Notify all friends
        friendIds.forEach(friendId => {
          io.to(`user_${friendId}`).emit('friend_stopped_studying', {
            userId: currentUserId,
            duration
          });
        });
      }
    });

    // Handle getting online friends (for manual refresh)
    socket.on('get_online_friends', async (friendIdsArray) => {
      // Use provided friendIds or fallback to user's friends
      const idsToCheck = friendIdsArray && friendIdsArray.length > 0 
        ? friendIdsArray.map(id => id.toString())
        : friendIds;
      
      // Normalize IDs to strings for comparison
      const activeUserIds = Array.from(activeUsers.keys()).map(key => key.toString());
      const onlineFriends = idsToCheck.filter(id => activeUserIds.includes(id.toString()));
      socket.emit('online_friends', onlineFriends);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.userId);
      const currentUserId = socket.userId.toString();
      
      // Notify all friends that this user is now offline
      friendIds.forEach(friendId => {
        io.to(`user_${friendId}`).emit('friend_offline', {
          userId: currentUserId
        });
      });
      
      // Remove from active users
      activeUsers.delete(socket.userId);
    });

  } catch (error) {
    console.error('Error handling socket connection:', error);
    socket.disconnect();
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
}); 