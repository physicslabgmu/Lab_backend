const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
require('dotenv').config(); // Ensure environment variables are loaded

// User Schema
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, trim: true, lowercase: true},
    password: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, default: 'user' },
    createdAt: { type: Date, default: Date.now }
});

// ✅ Ensure the unique index is created properly
userSchema.index({ email: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
module.exports = User;

// ✅ Register Endpoint (Fixed Version)
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        console.log('🔹 Register request:', { name, email });

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Ensure email is case-insensitive unique
        const emailToCheck = email.toLowerCase().trim();
        console.log('🔍 Checking if email exists:', emailToCheck);

        const existingUser = await User.findOne({ email: emailToCheck });
        console.log('🔍 Found user in DB:', existingUser);

        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password safely
        let hashedPassword;
        try {
            const salt = await bcrypt.genSalt(10);
            hashedPassword = await bcrypt.hash(password, salt);
        } catch (err) {
            console.error('❌ Error hashing password:', err);
            return res.status(500).json({ error: 'Password encryption failed' });
        }

        // Create user
        const user = new User({ email: emailToCheck, password: hashedPassword, name, role: 'user' });

        try {
            console.log('📝 Attempting to save user:', user);
            await user.save();
            console.log('✅ User successfully saved:', user._id);
        } catch (err) {
            console.error('❌ Error saving user to DB:', err);
            if (err.code === 11000) {
                return res.status(400).json({ error: 'Email already registered (Duplicate Key Issue)' });
            }
            return res.status(500).json({ error: 'Database save failed' });
        }

        // Create JWT Token
        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'Registration successful',
            token,
            user: { id: user._id, email: user.email, name: user.name, role: user.role }
        });

    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// Login endpoint
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log('Login request:', { email }); // Debug log

        // Validate input
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Create token
        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Verify token endpoint
router.get('/verify', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1]; // Extract token
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        res.json({
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Token verification error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
});

// ✅ Allow CORS for frontend communication
const cors = require('cors');
router.use(cors({
    origin: ['*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

module.exports = router;
