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

// Store URLs in memory
let urlDatabase = [];

function debugLog(...args) {
    if (DEBUG) {
        console.log('[DEBUG]', ...args);
    }
}

// Function to extract keywords from text
function extractKeywords(text) {
    return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2);
}

// Load URLs from file
function loadUrlDatabase() {
    try {
        const data = fs.readFileSync('file_urls.txt', 'utf8');
        urlDatabase = data
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && line.startsWith('http') && !line.includes('logo'))
            .map(url => {
                const urlParts = url.split('/');
                const fileName = decodeURIComponent(urlParts[urlParts.length - 1]);
                const category = urlParts[urlParts.length - 2] || '';
                const keywords = extractKeywords(fileName + ' ' + category);
                return { url, fileName, category, keywords };
            });
        debugLog(`Loaded ${urlDatabase.length} URLs`);
        return urlDatabase;
    } catch (error) {
        console.error('Error loading URL database:', error);
        return [];
    }
}

// Function to get relevant URLs based on keyword matching
function getRelevantUrls(query) {
    try {
        if (urlDatabase.length === 0) {
            console.error('URL database is empty');
            return [];
        }

        const queryKeywords = extractKeywords(query);
        const isImageQuery = /\b(image|picture|photo|show|see|look|display)\b/i.test(query);
        
        // Score URLs based on keyword matches
        const scoredUrls = urlDatabase.map(urlData => {
            let score = 0;
            
            // Score based on keyword matches
            queryKeywords.forEach(keyword => {
                if (urlData.keywords.includes(keyword)) score += 1;
                if (urlData.category.toLowerCase().includes(keyword)) score += 0.5;
            });
            
            // Bonus for course number matches
            const courseMatch = query.match(/phy\s*\d{3}/i);
            if (courseMatch && urlData.url.toLowerCase().includes(courseMatch[0].replace(/\s+/g, ''))) {
                score += 2;
            }
            
            // Bonus for images in image queries
            const isImage = /\.(jpg|jpeg|png|gif)$/i.test(urlData.fileName);
            if (isImageQuery && isImage) score += 1;
            
            return { ...urlData, score };
        });
        
        // Sort by score and get top results
        const sortedUrls = scoredUrls
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, isImageQuery ? 3 : 5)
            .map(({ url, fileName }) => {
                const fileType = fileName.split('.').pop().toLowerCase();
                const icon = fileType === 'pdf' ? '📄' : ['jpg', 'jpeg', 'png', 'gif'].includes(fileType) ? '🖼️' : '•';
                return `${icon} [${decodeURIComponent(fileName)}](${url})`;
            });
            
        debugLog('Found relevant URLs:', sortedUrls);
        return sortedUrls;
    } catch (error) {
        console.error('Error in getRelevantUrls:', error);
        return [];
    }
}

// Initialize URL database
loadUrlDatabase();
debugLog('Loaded URL database');

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
        const relevantUrls = await getRelevantUrls(prompt);
        debugLog('Found relevant URLs:', relevantUrls);
        
        // Create context-specific system prompt
        const fullPrompt = `You are a helpful assistant for the GMU Physics Lab. 
When responding about physics topics:
1. If the user asks about an experiment or equipment, ALWAYS include relevant images in your response
2. When showing images, describe what each image shows
3. Format images with proper markdown: 🖼️ [Image Title](URL)
4. Include course numbers when relevant (e.g., PHY 161, PHY 260)
5. Be concise and clear in your explanations

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
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(prompt);
        
        if (!result) {
            throw new Error('No result from Gemini API');
        }
        
        const response = await result.response;
        const text = response.text();
        
        // Transform links to icons
        const transformedText = transformLinksToIcons(text);
        
        res.json({ 
            message: transformedText,
            styles: linkIconStyle + pdfIconStyle + imageLinkStyle,
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

// Function to transform raw links into clickable icons
function transformLinksToIcons(text) {
    // First, handle markdown-style image links with titles
    text = text.replace(/🖼️ \[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, (match, title, url) => {
        const cleanedUrl = cleanUrl(url);
        if (cleanedUrl.toLowerCase().match(/\.(jpg|jpeg|png|gif)$/)) {
            return `<div class="chat-image-container">
                <img src='${cleanedUrl}' class='chat-image' alt='${title}' title='${title}' />
                <div class="image-caption">${title}</div>
            </div>`;
        }
        return match;
    });

    // Then handle any remaining URLs
    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    return text.replace(urlRegex, (url) => {
        const cleanedUrl = cleanUrl(url);
        if (cleanedUrl.toLowerCase().endsWith('.pdf')) {
            return `<a href='${cleanedUrl}' target='_blank'><i class='pdf-icon'></i> PDF Document</a>`;
        } else if (cleanedUrl.toLowerCase().match(/\.(jpg|jpeg|png|gif)$/)) {
            return `<div class="chat-image-container">
                <img src='${cleanedUrl}' class='chat-image' alt='Image' />
            </div>`;
        } else {
            return `<a href='${cleanedUrl}' target='_blank'><i class='link-icon'></i> Link</a>`;
        }
    });
}

// Add CSS for the link icon
const linkIconStyle = `<style>
.link-icon {
    display: inline-block;
    width: 16px;
    height: 16px;
    background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M10 6V8H5V19H16V14H18V20C18 20.5523 17.5523 21 17 21H4C3.44772 21 3 20.5523 3 20V7C3 6.44772 3.44772 6 4 6H10ZM21 3V11H19V6.413L11.207 14.207L9.793 12.793L17.585 5H13V3H21Z" fill="%23007BFF"/></svg>');
    background-repeat: no-repeat;
    background-position: center;
    cursor: pointer;
}

.chat-image-container {
    margin: 10px 0;
    max-width: 100%;
    text-align: center;
}

.chat-image {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.image-caption {
    margin-top: 5px;
    font-size: 0.9em;
    color: #666;
}
</style>`;

// Add CSS for the PDF icon
const pdfIconStyle = `<style>
.pdf-icon {
    display: inline-block;
    width: 16px;
    height: 16px;
    background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8.267 14.68c-.184 0-.308.018-.372.036v1.178c.076.018.171.023.302.023.479 0 .774-.242.774-.651 0-.364-.235-.606-.704-.606zm3.487.012c-.2 0-.33.018-.407.036v2.61c.077.018.201.018.313.018.817.006 1.349-.444 1.349-1.396 0-.979-.59-1.268-1.255-1.268z" fill="%23FF0000"/></svg>');
    background-repeat: no-repeat;
    background-position: center;
    cursor: pointer;
    border: 1px solid #FF0000;
    border-radius: 3px;
    padding: 2px;
}
</style>`;

// Add CSS for the image link
const imageLinkStyle = `<style>
.image-link {
    max-width: 100%;
    height: auto;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 5px;
    cursor: pointer;
}
</style>`;

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
