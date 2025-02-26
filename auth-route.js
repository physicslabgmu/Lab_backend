const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// User Schema
const userSchema = new mongoose.Schema({
    email: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true,
        lowercase: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    password: { 
        type: String, 
        required: true,
        minlength: [6, 'Password must be at least 6 characters long']
    },
    name: { 
        type: String, 
        required: true,
        trim: true,
        minlength: [2, 'Name must be at least 2 characters long']
    },
    role: { 
        type: String, 
        default: 'user',
        enum: ['user', 'admin']
    },
    isVerified: { 
        type: Boolean, 
        default: false 
    },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// OTP Schema
const otpSchema = new mongoose.Schema({
    email: { 
        type: String, 
        required: true 
    },
    otp: { 
        type: String, 
        required: true 
    },
    createdAt: { 
        type: Date, 
        default: Date.now, 
        expires: 60 // OTP expires after 60 seconds
    }
});

const OTP = mongoose.model('OTP', otpSchema);

// Nodemailer setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Generate OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP via email
async function sendOTPEmail(email, otp) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Email Verification Code - GMU Physics Lab',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <img src="https://lab-backend-nwko.onrender.com/logo.png" alt="GMU Physics Lab" style="max-width: 200px;">
                </div>
                <h2 style="color: #006633; text-align: center;">Email Verification</h2>
                <p style="color: #555; font-size: 16px;">Thank you for registering with GMU Physics Lab! Please use the following verification code to complete your registration:</p>
                <div style="background-color: #f5f5f5; padding: 15px; text-align: center; border-radius: 5px; margin: 20px 0;">
                    <h1 style="color: #006633; letter-spacing: 5px; margin: 0;">${otp}</h1>
                </div>
                <p style="color: #555; font-size: 14px;">This code will expire in 1 minute.</p>
                <p style="color: #555; font-size: 14px;">If you didn't request this verification, please ignore this email.</p>
            </div>
        `
    };

    return transporter.sendMail(mailOptions);
}

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        req.user = verified;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// Send OTP for email verification
router.post('/send-otp', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // For login verification, we don't need to check if the user is verified
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(400).json({ error: 'Email not registered' });
        }

        // Generate OTP
        const otp = generateOTP();

        // Hash OTP before storing
        const hashedOTP = await bcrypt.hash(otp, 10);

        // Save OTP to database
        await OTP.findOneAndDelete({ email: email.toLowerCase() }); // Delete any existing OTP
        await OTP.create({ email: email.toLowerCase(), otp: hashedOTP });

        // Send OTP via email
        await sendOTPEmail(email, otp);

        res.status(200).json({ message: 'Verification code sent to your email' });
    } catch (error) {
        console.error('Error sending OTP:', error);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ error: 'Email and verification code are required' });
        }

        // Find OTP in database
        const otpRecord = await OTP.findOne({ email: email.toLowerCase() });
        if (!otpRecord) {
            return res.status(400).json({ error: 'Verification code expired or invalid' });
        }

        // Verify OTP
        const isValidOTP = await bcrypt.compare(otp, otpRecord.otp);
        if (!isValidOTP) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        // Update user verification status if user exists
        const user = await User.findOne({ email: email.toLowerCase() });
        if (user) {
            user.isVerified = true;
            await user.save();
        }

        // Delete OTP record
        await OTP.findOneAndDelete({ email: email.toLowerCase() });

        res.status(200).json({ message: 'Email verified successfully' });
    } catch (error) {
        console.error('Error verifying OTP:', error);
        res.status(500).json({ error: 'Failed to verify email' });
    }
});

// Resend OTP
router.post('/resend-otp', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Generate new OTP
        const otp = generateOTP();

        // Hash OTP before storing
        const hashedOTP = await bcrypt.hash(otp, 10);

        // Save OTP to database
        await OTP.findOneAndDelete({ email: email.toLowerCase() }); // Delete any existing OTP
        await OTP.create({ email: email.toLowerCase(), otp: hashedOTP });

        // Send OTP via email
        await sendOTPEmail(email, otp);

        res.status(200).json({ message: 'Verification code resent to your email' });
    } catch (error) {
        console.error('Error resending OTP:', error);
        res.status(500).json({ error: 'Failed to resend verification code' });
    }
});

// Register new user
router.post('/register', async (req, res) => {
    try {
        const { name, email, password, otp } = req.body;

        // Input validation
        if (!name || !email || !password || !otp) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }

        // Check if user already exists and is verified
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser && existingUser.isVerified) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Find and verify OTP
        const otpRecord = await OTP.findOne({ email: email.toLowerCase() });
        if (!otpRecord) {
            return res.status(400).json({ error: 'Verification code expired or invalid' });
        }

        // Verify OTP
        const isValidOTP = await bcrypt.compare(otp, otpRecord.otp);
        if (!isValidOTP) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        // Delete OTP record after verification
        await OTP.findOneAndDelete({ email: email.toLowerCase() });

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create or update user
        let user;
        if (existingUser) {
            existingUser.name = name;
            existingUser.password = hashedPassword;
            existingUser.isVerified = true;
            user = await existingUser.save();
        } else {
            user = new User({
                name,
                email: email.toLowerCase(),
                password: hashedPassword,
                isVerified: true
            });
            await user.save();
        }

        // Create token
        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'Registration successful',
            token,
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role,
                isVerified: user.isVerified
            }
        });
    } catch (error) {
        console.error('Error in register:', error);
        if (error.name === 'ValidationError') {
            return res.status(400).json({ error: Object.values(error.errors).map(err => err.message).join(', ') });
        }
        res.status(500).json({ error: 'Failed to register user' });
    }
});

// Login endpoint
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Input validation
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Find user by email
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        // Check if user is verified
        if (!user.isVerified) {
            return res.status(401).json({ error: 'Email not verified', needsVerification: true });
        }

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        // Create and assign token
        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role,
                isVerified: user.isVerified
            }
        });
    } catch (error) {
        console.error('Error in login:', error);
        res.status(500).json({ error: 'Failed to login' });
    }
});

// Verify token endpoint
router.get('/verify', verifyToken, (req, res) => {
    res.json({ 
        valid: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            role: req.user.role
        }
    });
});

module.exports = router;
