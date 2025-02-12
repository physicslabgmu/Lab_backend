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
// userSchema.index({ email: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
module.exports = User;

// ✅ Register Endpoint (Fixed Version)
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        console.log('🔹 Register request:', { name, email });

        // Validate input
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Ensure email is case-insensitive unique
        const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Ensure JWT_SECRET exists
        if (!process.env.JWT_SECRET) {
            console.error('❌ JWT_SECRET is missing.');
            return res.status(500).json({ error: 'Server misconfiguration' });
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
        const user = new User({ 
            email: email.toLowerCase().trim(), // ✅ Convert email to lowercase before saving
            password: hashedPassword,
            name,
            role: 'user'
        });

        try {
            await user.save();
        } catch (err) {
            if (err.code === 11000) { // ✅ Handle duplicate email error from MongoDB
                return res.status(400).json({ error: 'Email already registered' });
            }
            console.error('❌ Database save error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        console.log('✅ User registered:', user._id);

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
