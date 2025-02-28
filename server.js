const express = require('express');
const cors = require('cors');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');
const authRoutes = require('./auth-route');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Google Gemini AI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
}
const genAI = new GoogleGenerativeAI(apiKey);

// Add debugging configuration
const DEBUG = process.env.DEBUG || true;

function debugLog(...args) {
    if (DEBUG) {
        console.log('[DEBUG]', ...args);
    }
}

// Load URLs from file_urls.txt
function loadUrlDatabase() {
    try {
        const data = fs.readFileSync('file_urls.txt', 'utf8');
        return data
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && line.startsWith('http') && !line.includes('logo'));
    } catch (error) {
        console.error('Error loading URL database:', error);
        return [];
    }
}

// Initialize URL database
const urlDatabase = loadUrlDatabase();
debugLog('Loaded URL database with ' + urlDatabase.length + ' URLs');

// Function to clean and validate URLs
function cleanUrl(url) {
    if (!url) return '';
    
    // Remove parentheses from start and end
    url = url.replace(/^[\(\[]+/, '').replace(/[\)\]]+$/, '');
    
    // Remove other trailing characters that aren't part of a valid URL
    url = url.replace(/[\),\]\}>\s]+$/, '');
    
    // Ensure it starts with http/https
    if (!url.startsWith('http')) {
        return '';
    }
    
    return url.trim();
}

// Function to encode URLs properly
function encodeURL(url) {
    // Split the URL into parts (before and after the filename)
    const parts = url.split('/');
    const filename = parts.pop(); // Get the last part (filename)
    const basePath = parts.join('/'); // Rejoin the rest
    
    // Encode the filename part only
    const encodedFilename = encodeURIComponent(filename);
    
    // Return the full encoded URL
    return `${basePath}/${encodedFilename}`;
}

// Function to get relevant URLs based on query
function getRelevantUrls(query) {
    try {
        const urls = urlDatabase;
        if (!urls || urls.length === 0) {
            console.error('URL database is empty');
            return [];
        }

        query = query.toLowerCase();
        const queryWords = query.split(/\s+/).filter(word => word.length > 2);
        
        // Create a scoring system for URLs
        const scoredUrls = urls.map(url => {
            let score = 0;
            const urlLower = url.toLowerCase();
            const urlParts = url.split('/');
            const coursePart = urlParts.find(part => /phy\d{3}/.test(part.toLowerCase())) || '';
            const category = urlParts[urlParts.length - 2] || '';
            const fileName = urlParts[urlParts.length - 1] || '';
            
            // Score based on course number match
            const courseMatch = query.match(/phy\s*\d{3}/i);
            if (courseMatch && urlLower.includes(courseMatch[0].replace(/\s+/g, '').toLowerCase())) {
                score += 10;
            }
            
            // Score based on category match
            queryWords.forEach(word => {
                if (category.toLowerCase().includes(word)) score += 5;
                if (fileName.toLowerCase().includes(word)) score += 3;
                if (urlLower.includes(word)) score += 1;
            });
            
            // Bonus for PDF files (likely more informative)
            if (fileName.toLowerCase().endsWith('.pdf')) score += 2;
            
            return { url, score };
        });
        
        // Sort by score and get top results
        const sortedUrls = scoredUrls
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(item => item.url);
            
        // Format URLs for display
        return sortedUrls.slice(0, 8).map(url => {
            const fileName = url.split('/').pop();
            const fileType = fileName.split('.').pop().toLowerCase();
            const icon = fileType === 'pdf' ? '📄' : ['jpg', 'jpeg', 'png', 'gif'].includes(fileType) ? '🖼️' : '•';
            return `${icon} [${decodeURIComponent(fileName)}](${url})`;
        });
    } catch (error) {
        console.error('Error in getRelevantUrls:', error);
        return [];
    }
}

// Enhanced system prompt for better context
const baseSystemPrompt = `You are a helpful assistant for the GMU Physics Lab. Your role is to help students and faculty find resources and information about physics lab experiments and equipment.

When responding to queries:
1. Always provide relevant URLs from the database when available
2. Format URLs with appropriate icons (🖼️ for images, 📄 for PDFs)
3. Group resources by course when possible
4. If a specific course is mentioned, focus on that course's resources first
5. For equipment queries, include images of the equipment when available
6. For experiment queries, prioritize lab manuals and setup images
7. If you can't find exact matches, suggest related resources
8. Always include course numbers in your responses (e.g., "For PHY 261...")
9. Explain what each resource contains or shows
10. If no specific resources are found, suggest related topics or courses

Example responses:
"For PHY 261 AC Circuits, here are some helpful resources:
🖼️ [ac_circuit.jpg] - Shows the complete circuit setup
🖼️ [pic2.jpg] - Detailed view of the components
📄 [AC_Circuit_Manual.pdf] - Complete lab manual with instructions"

"Here are resources for the pendulum experiment:
PHY 161:
🖼️ [pendulum_setup.jpg] - Shows the proper pendulum setup
📄 [pendulum_guide.pdf] - Detailed experiment instructions"

Make sure you give the correct links from file_urls.txt 

Instead of the links directly being sent to the LLM in prompt, and then asking LLM to return relevant links based on user query, 
let us maintain vector embeddings in-memory for each link and then do semantic search to retrieve say top 5 links based on user query. 

Then we can send these 5 links to the LLM and ask it to form an answer using those.`;

// Configure CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// ✅ Explicitly handle preflight requests
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.sendStatus(200);
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..')));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Use authentication routes
app.use('/api/auth', authRoutes);

// Chat endpoint with rate limiting
app.post('/api/auth/chat', async (req, res) => {
    try {
        const { prompt } = req.body;
        debugLog('Received chat request:', { prompt });

        if (!prompt) {
            return res.status(400).json({
                error: true,
                message: "Please enter a message"
            });
        }

        // Get relevant URLs based on the query
        const relevantUrls = getRelevantUrls(prompt);
        debugLog('Found relevant URLs:', relevantUrls);
        
        // Create context-specific system prompt
        const fullPrompt = `You are a helpful assistant for the GMU Physics Lab. 
When responding about physics topics:
1. Include relevant course numbers (e.g., PHY 161, PHY 260)
2. Reference specific lab equipment and setups
3. Explain concepts clearly and concisely
4. Link to relevant resources when available

Here are some relevant resources for this query:
${relevantUrls.join('\n')}

User Query: ${prompt}`;

        debugLog('Full prompt:', fullPrompt);

        // Add request to queue
        requestQueue.push({ prompt: fullPrompt, res });
        
        // Start processing if not already running
        if (!isProcessing) {
            processQueue();
        }
        
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            error: true,
            message: 'Server error occurred',
            details: error.message
        });
    }
});

// Chat endpoint with rate limiting (keeping the old endpoint for backward compatibility)
app.post('/api/chat', async (req, res) => {
    try {
        const { prompt } = req.body;
        debugLog('Received chat request:', { prompt });

        if (!prompt) {
            return res.status(400).json({
                error: true,
                message: "Please enter a message"
            });
        }

        // Get relevant URLs based on the query
        const relevantUrls = getRelevantUrls(prompt);
        debugLog('Found relevant URLs:', relevantUrls);
        
        // Create context-specific system prompt
        const fullPrompt = `You are a helpful assistant for the GMU Physics Lab. 
When responding about physics topics:
1. Include relevant course numbers (e.g., PHY 161, PHY 260)
2. Reference specific lab equipment and setups
3. Explain concepts clearly and concisely
4. Link to relevant resources when available

Here are some relevant resources for this query:
${relevantUrls.join('\n')}

User Query: ${prompt}`;

        debugLog('Full prompt:', fullPrompt);

        // Add request to queue
        requestQueue.push({ prompt: fullPrompt, res });
        
        // Start processing if not already running
        if (!isProcessing) {
            processQueue();
        }
        
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            error: true,
            message: 'Server error occurred',
            details: error.message
        });
    }
});

// Add rate limiting
const requestQueue = [];
let isProcessing = false;
const RATE_LIMIT_DELAY = 2000; // 2 seconds between requests

// Function to process the queue
async function processQueue() {
    if (isProcessing || requestQueue.length === 0) return;
    
    isProcessing = true;
    const { prompt, res } = requestQueue.shift();
    
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(prompt);
        
        if (!result) {
            throw new Error('No result from Gemini API');
        }
        
        const response = await result.response;
        const text = response.text();
        
        res.json({ 
            message: text,
            success: true 
        });
    } catch (error) {
        console.error('Error processing queue item:', error);
        res.status(500).json({
            error: true,
            message: 'Please wait a moment and try again.',
            details: error.message
        });
    } finally {
        isProcessing = false;
        // Wait before processing next request
        setTimeout(() => processQueue(), RATE_LIMIT_DELAY);
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    const apiKeyPresent = !!process.env.GEMINI_API_KEY;
    res.status(200).json({ 
        status: 'healthy',
        apiKeyPresent,
        debug: DEBUG
    });
});

// Error handlers
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    res.status(500).json({ 
        error: "Internal server error", 
        details: err.message,
        message: 'An unexpected error occurred. Please try again.'
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log('Debug mode:', DEBUG);
    console.log('API Key present:', !!process.env.GEMINI_API_KEY);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Try:\n1. Close existing server\n2. Run: npx kill-port ${port}\n3. Use different port: PORT=3001 node server.js`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
