const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const cryptoRandomString = require('crypto-random-string');

// User Schema
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, default: 'user' },
    createdAt: { type: Date, default: Date.now },
    isVerified: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);

// Email configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Add these to your .env file
        pass: process.env.EMAIL_PASS
    }
});

// Store verification codes temporarily (in production, use Redis or similar)
const verificationCodes = new Map();

// Helper function to send verification email
async function sendVerificationEmail(email, code) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Email Verification - GMU Physics Lab',
        html: `
            <h2>Email Verification</h2>
            <p>Your verification code is: <strong>${code}</strong></p>
            <p>This code will expire in 10 minutes.</p>
            <p>If you didn't request this code, please ignore this email.</p>
        `
    };

    await transporter.sendMail(mailOptions);
}

// Request verification code
router.post('/request-verification', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Generate verification code
        const verificationCode = cryptoRandomString({ length: 6, type: 'numeric' });
        
        // Store the verification code and user data temporarily
        verificationCodes.set(email, {
            code: verificationCode,
            userData: { name, email, password },
            timestamp: Date.now()
        });

        // Send verification email
        await sendVerificationEmail(email, verificationCode);

        // Set timeout to delete verification code after 10 minutes
        setTimeout(() => {
            verificationCodes.delete(email);
        }, 10 * 60 * 1000);

        res.json({ message: 'Verification code sent successfully' });
    } catch (error) {
        console.error('Error in request-verification:', error);
        res.status(500).json({ error: 'Failed to send verification code' });
    }
});

// Verify email and complete registration
router.post('/verify-email', async (req, res) => {
    try {
        const { email, verificationCode } = req.body;

        // Get stored verification data
        const verificationData = verificationCodes.get(email);
        if (!verificationData) {
            return res.status(400).json({ error: 'Verification code expired or invalid' });
        }

        // Check if code matches
        if (verificationData.code !== verificationCode) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        // Check if code is expired (10 minutes)
        if (Date.now() - verificationData.timestamp > 10 * 60 * 1000) {
            verificationCodes.delete(email);
            return res.status(400).json({ error: 'Verification code expired' });
        }

        // Get the stored user data
        const { name, password } = verificationData.userData;

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create new user
        const user = new User({
            name,
            email,
            password: hashedPassword,
            isVerified: true
        });

        await user.save();

        // Delete verification code
        verificationCodes.delete(email);

        // Create token
        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Email verified and registration completed',
            token,
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Error in verify-email:', error);
        res.status(500).json({ error: 'Failed to verify email' });
    }
});

// Resend verification code
router.post('/resend-code', async (req, res) => {
    try {
        const { email } = req.body;

        // Check if there's an existing verification attempt
        const existingVerification = verificationCodes.get(email);
        if (!existingVerification) {
            return res.status(400).json({ error: 'No pending verification found' });
        }

        // Generate new verification code
        const newVerificationCode = cryptoRandomString({ length: 6, type: 'numeric' });

        // Update stored verification data
        verificationCodes.set(email, {
            ...existingVerification,
            code: newVerificationCode,
            timestamp: Date.now()
        });

        // Send new verification email
        await sendVerificationEmail(email, newVerificationCode);

        // Set timeout to delete verification code after 10 minutes
        setTimeout(() => {
            verificationCodes.delete(email);
        }, 10 * 60 * 1000);

        res.json({ message: 'New verification code sent successfully' });
    } catch (error) {
        console.error('Error in resend-code:', error);
        res.status(500).json({ error: 'Failed to resend verification code' });
    }
});

// Login endpoint
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user by email
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        // Check if email is verified
        if (!user.isVerified) {
            return res.status(400).json({ error: 'Email is not verified' });
        }

        // Validate password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid email or password' });
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
        res.status(500).json({ error: 'Login failed' });
    }
});

// Verify token endpoint
router.get('/verify', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
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

module.exports = router;
