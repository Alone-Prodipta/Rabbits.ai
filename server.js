const http = require('http');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = process.env.PORT || 3000;

// Environment Keys from Render
const geminiKey = process.env.GEMINI_API_KEY;
const cogneeKey = process.env.COGNEE_API_KEY;
const tenantUrl = "https://tenant-1e7717fd-de8f-42ba-8a52-7bb1c5d151a8.aws.cognee.ai";
const tenantId = "1e7717fd-de8f-42ba-8a52-7bb1c5d151a8";

// Initialize Gemini
const genAI = new GoogleGenerativeAI(geminiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const cogneeHeaders = {
    "X-Api-Key": cogneeKey,
    "X-Tenant-Id": tenantId,
    "Content-Type": "application/json"
};

const server = http.createServer(async (req, res) => {
    // Handle CORS requirements
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // --- API ROUTE: Handles Cognee + Gemini AI pipeline ---
    if (req.method === 'POST' && req.url === '/api/chat') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsedBody = JSON.parse(body || '{}');
                const userMessage = parsedBody.message;

                if (!userMessage) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'No message provided' }));
                }

                // 1. RECALL: Query historical context from Cognee
                let retrievedContext = "No historical context returned.";
                try {
                    const searchResponse = await fetch(`${tenantUrl}/api/v1/search`, {
                        method: 'POST',
                        headers: cogneeHeaders,
                        body: JSON.stringify({
                            query: userMessage,
                            search_type: "GRAPH_COMPLETION",
                            top_k: 5
                        })
                    });
                    if (searchResponse.ok) {
                        const searchData = await searchResponse.json();
                        retrievedContext = JSON.stringify(searchData);
                    }
                } catch (e) {
                    console.error("Cognee Recall Error:", e);
                }

                // 2. GENERATE: Prompt Gemini with the memory layer
                const systemPrompt = `You are Rab-bits AI. Here is the historical long-term memory graph context matching the user: ${retrievedContext}`;
                const fullPrompt = `${systemPrompt}\n\nUser Current Message: ${userMessage}`;
                
                const result = await model.generateContent(fullPrompt);
                const aiText = result.response.text();

                // 3. REMEMBER: Ingest statement into Cognee asynchronously
                try {
                    await fetch(`${tenantUrl}/api/v1/add`, {
                        method: 'POST',
                        headers: cogneeHeaders,
                        body: JSON.stringify({ datasetName: "rab_bits_dataset", textData: [userMessage] })
                    });
                    await fetch(`${tenantUrl}/api/v1/cognify`, {
                        method: 'POST',
                        headers: cogneeHeaders,
                        body: JSON.stringify({ datasets: ["rab_bits_dataset"] })
                    });
                } catch (e) {
                    console.error("Cognee Ingestion Error:", e);
                }

                // Format structure expected cleanly by your script.js template
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    candidates: [{ content: { parts: [{ text: aiText }] } }]
                }));

            } catch (error) {
                console.error("Server Error:", error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Internal Server Error" }));
            }
        });
        return;
    }

    // --- STATIC FILES ROUTE: Serves index.html, style.css, script.js ---
    let filePath = req.url === '/' ? './index.html' : `.${req.url}`;
    const extname = String(path.extname(filePath)).toLowerCase();
    
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}\n`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Native server running on port ${PORT}`);
});