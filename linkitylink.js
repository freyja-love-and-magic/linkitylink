#!/usr/bin/env node

/**
 * Linkitylink - Privacy-First Link Page Service
 *
 * Creates beautiful SVG link pages from user-provided link data
 * Public access via emojicode - no authentication required for viewers
 *
 * Flow:
 * 1. User creates link page via POST /create or web interface
 * 2. BDO made public → generates shareable emojicode
 * 3. Anyone can view: linkitylink?emojicode=😀🔗💎🌟...
 * 4. Linkitylink renders links into beautiful SVG layouts
 */

import express from 'express';
import session from 'express-session';
import store from 'memorystore';
import fountLib from 'fount-js';
import bdoLib from 'bdo-js';
import addieLib from 'addie-js';
import sessionless from 'sessionless-node';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Import relevantBDOs middleware
import {
    relevantBDOsMiddleware,
    getRelevantBDOs,
    setRelevantBDOs,
    clearRelevantBDOs,
    toStripeMetadata,
    logRelevantBDOs,
    configureBdoLib,
    fetchAndExtractPayees,
    logPayees
} from './lib/relevant-bdos-middleware.js';

// Import app handoff module
import {
    createPendingHandoff,
    getPendingHandoff,
    verifyAuthSequence,
    associateAppCredentials,
    completeHandoff,
    getHandoffForApp,
    getHandoffStats
} from './lib/app-handoff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MemoryStore = store(session);

// Stats file path
const STATS_FILE = join(__dirname, 'data', 'stats.json');

const app = express();
const PORT = process.env.PORT || 3010;

// Configuration (defaults to dev environment)
const FOUNT_BASE_URL = process.env.FOUNT_BASE_URL || 'https://dev.fount.allyabase.com/';
const BDO_BASE_URL = process.env.BDO_BASE_URL || 'https://dev.bdo.allyabase.com';
const ADDIE_BASE_URL = process.env.ADDIE_BASE_URL || 'https://dev.addie.allyabase.com';
const ENABLE_APP_PURCHASE = process.env.ENABLE_APP_PURCHASE === 'true';

// Base path for proxied environments (e.g., '/plugin/linkitylink' when served through fedwiki)
const BASE_PATH = process.env.BASE_PATH || '';

/**
 * Inject <base> tag into HTML for proper asset loading when proxied
 * @param {string} html - HTML content
 * @returns {string} - HTML with injected base tag
 */
function injectBasePath(html) {
  if (!BASE_PATH) return html;

  // Inject <base href="/plugin/linkitylink/"> into <head>
  const baseTag = `<base href="${BASE_PATH}/">`;
  return html.replace('<head>', `<head>\n    ${baseTag}`);
}

// Configure SDKs
fountLib.baseURL = FOUNT_BASE_URL.endsWith('/') ? FOUNT_BASE_URL : `${FOUNT_BASE_URL}/`;
bdoLib.baseURL = BDO_BASE_URL.endsWith('/') ? BDO_BASE_URL : `${BDO_BASE_URL}/`;
addieLib.baseURL = ADDIE_BASE_URL.endsWith('/') ? ADDIE_BASE_URL : `${ADDIE_BASE_URL}/`;

// Configure relevantBDOs middleware with bdo-js instance
configureBdoLib(bdoLib);

console.log('🔗 Linkitylink - Privacy-First Link Pages');
console.log('========================================');
console.log(`📍 Port: ${PORT}`);
console.log(`📍 Fount URL: ${fountLib.baseURL}`);
console.log(`📍 BDO URL: ${bdoLib.baseURL}`);
console.log(`📍 Addie URL: ${ADDIE_BASE_URL}`);
console.log(`📍 App Purchase: ${ENABLE_APP_PURCHASE ? 'Enabled' : 'Disabled'}`);
console.log('📍 Architecture: Server returns identifiers only (clients construct URLs)');

// Configuration endpoint - allows dynamic base URL configuration
app.post('/config', express.json(), (req, res) => {
    try {
        const { fountURL, bdoURL, addieURL } = req.body;

        if (fountURL) {
            fountLib.baseURL = fountURL.endsWith('/') ? fountURL : `${fountURL}/`;
            console.log(`🔧 Fount URL updated: ${fountLib.baseURL}`);
        }

        if (bdoURL) {
            bdoLib.baseURL = bdoURL.endsWith('/') ? bdoURL : `${bdoURL}/`;
            configureBdoLib(bdoLib);
            console.log(`🔧 BDO URL updated: ${bdoLib.baseURL}`);
        }

        if (addieURL) {
            addieLib.baseURL = addieURL.endsWith('/') ? addieURL : `${addieURL}/`;
            console.log(`🔧 Addie URL updated: ${addieLib.baseURL}`);
        }

        res.json({
            success: true,
            config: {
                fountURL: fountLib.baseURL,
                bdoURL: bdoLib.baseURL,
                addieURL: addieLib.baseURL
            }
        });
    } catch (error) {
        console.error('❌ Configuration error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current configuration
app.get('/config', (req, res) => {
    res.json({
        fountURL: fountLib.baseURL,
        bdoURL: bdoLib.baseURL,
        addieURL: addieLib.baseURL
    });
});

// Session middleware - gives users persistent sessions
app.use(session({
  store: new MemoryStore({
    checkPeriod: 86400000 // prune expired entries every 24h
  }),
  resave: false,
  saveUninitialized: false,
  secret: 'linkitylink-privacy-first-links-2025',
  cookie: {
    maxAge: 31536000000, // 1 year (basically never expire)
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Middleware
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());
app.use(relevantBDOsMiddleware); // Extract relevantBDOs from requests and store in session

// ========== STATS TRACKING ==========

/**
 * Load stats from disk
 */
async function loadStats() {
    try {
        const fs = await import('fs/promises');

        // Ensure data directory exists
        const dataDir = join(__dirname, 'data');
        try {
            await fs.access(dataDir);
        } catch {
            await fs.mkdir(dataDir, { recursive: true });
        }

        // Try to read stats file
        try {
            const data = await fs.readFile(STATS_FILE, 'utf-8');
            return JSON.parse(data);
        } catch {
            // File doesn't exist, return default stats
            return {
                totalSales: 0,
                createdAt: new Date().toISOString(),
                lastUpdated: new Date().toISOString()
            };
        }
    } catch (error) {
        console.error('❌ Error loading stats:', error);
        return {
            totalSales: 0,
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
        };
    }
}

/**
 * Save stats to disk
 */
async function saveStats(stats) {
    try {
        const fs = await import('fs/promises');
        const writeFileAtomic = (await import('write-file-atomic')).default;

        stats.lastUpdated = new Date().toISOString();

        await writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 2));
        console.log(`📊 Stats saved: ${stats.totalSales} total sales`);
    } catch (error) {
        console.error('❌ Error saving stats:', error);
    }
}

/**
 * Increment total sales counter
 */
async function incrementSales() {
    try {
        const stats = await loadStats();
        stats.totalSales += 1;
        await saveStats(stats);
        console.log(`🎉 Sale #${stats.totalSales} recorded!`);
        return stats.totalSales;
    } catch (error) {
        console.error('❌ Error incrementing sales:', error);
        return null;
    }
}

/**
 * View linkitylink by emojicode
 * Route: /view/:emojicode
 */
app.get('/view/:emojicode', async (req, res) => {
    try {
        const { emojicode } = req.params;

        console.log(`😀 Fetching Linkitylink by emojicode: ${emojicode}`);

        let links = [];
        let userName = 'My Links';

        try {
            // Fetch Linkitylink BDO by emojicode
            const linkHubBDO = await bdoLib.getBDOByEmojicode(emojicode);

            console.log('📦 Linkitylink BDO fetched:', JSON.stringify(linkHubBDO).substring(0, 200));

            // Extract links from BDO data
            const bdoData = linkHubBDO.bdo || linkHubBDO;
            if (bdoData.links && Array.isArray(bdoData.links)) {
                links = bdoData.links;
                console.log(`🔗 Found ${links.length} links in Linkitylink BDO`);
            } else {
                console.log('⚠️ No links array found in Linkitylink BDO');
            }

            // Get user name from BDO
            userName = bdoData.title || bdoData.name || 'My Links';

        } catch (error) {
            console.error('❌ Failed to fetch Linkitylink BDO by emojicode:', error.message);
            // Continue with empty links - will show demo
        }

        // If no links, show demo links
        if (links.length === 0) {
            links = getDemoLinks();
            userName = 'Demo Links';
        }

        // Limit to 20 links
        const displayLinks = links.slice(0, 20);

        // Generate HTML page
        const html = generateLinkitylinkPage(displayLinks, userName, false, null);

        res.send(html);

    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).send('Error loading linkitylink');
    }
});

/**
 * Main route - Landing page or tapestry display
 *
 * No query params: Show landing page
 * Query params (Method 1 - Emojicode):
 * - emojicode: 8-emoji identifier for Linkitylink BDO
 *
 * Query params (Method 2 - Legacy Authentication):
 * - pubKey: User's public key
 * - timestamp: Request timestamp
 * - signature: Sessionless signature (timestamp + pubKey)
 */
app.get('/', async (req, res) => {
    try {
        const { emojicode, pubKey, timestamp, signature } = req.query;

        // Debug logging
        console.log('🔍 GET / query params:', { emojicode: emojicode ? emojicode.substring(0, 20) + '...' : 'none', pubKey: pubKey ? pubKey.substring(0, 16) + '...' : 'none' });

        // If no query parameters, serve landing page
        if (!emojicode && !pubKey && !timestamp && !signature) {
            const fs = await import('fs/promises');
            const landingPage = await fs.readFile(join(__dirname, 'public', 'index.html'), 'utf-8');
            return res.send(injectBasePath(landingPage));
        }

        let links = [];
        let userName = 'Anonymous';
        let authenticated = false;

        // Method 1: Fetch by emojicode (PUBLIC - no auth required)
        if (emojicode) {
            console.log(`😀 Fetching Linkitylink by emojicode: ${emojicode}`);

            try {
                // Fetch Linkitylink BDO by emojicode
                const linkHubBDO = await bdoLib.getBDOByEmojicode(emojicode);

                console.log('📦 Linkitylink BDO fetched:', JSON.stringify(linkHubBDO).substring(0, 200));

                // Extract links from BDO data
                const bdoData = linkHubBDO.bdo || linkHubBDO;
                if (bdoData.links && Array.isArray(bdoData.links)) {
                    links = bdoData.links;
                    console.log(`🔗 Found ${links.length} links in Linkitylink BDO`);
                } else {
                    console.log('⚠️ No links array found in Linkitylink BDO');
                }

                // Get user name from BDO
                userName = bdoData.title || bdoData.name || 'My Links';
                authenticated = false; // Public access via emojicode

            } catch (error) {
                console.error('❌ Failed to fetch Linkitylink BDO by emojicode:', error.message);
                // Continue with empty links array
            }
        }
        // Method 2: Legacy authentication (for backward compatibility)
        else if (pubKey && timestamp && signature) {
            console.log(`🔐 Authenticating request for pubKey: ${pubKey.substring(0, 16)}...`);

            // Verify signature
            const message = timestamp + pubKey;
            const isValid = sessionless.verifySignature(signature, message, pubKey);

            if (isValid) {
                console.log('✅ Signature valid, fetching user BDO...');
                authenticated = true;

                try {
                    // Fetch user's Fount BDO (which contains carrierBag)
                    const userBDO = await fountLib.getBDO(pubKey);

                    console.log('📦 User BDO fetched:', JSON.stringify(userBDO).substring(0, 200));

                    // Extract carrierBag from BDO
                    const bdo = userBDO.bdo || userBDO;
                    const carrierBag = bdo.carrierBag || bdo.data?.carrierBag;

                    if (carrierBag && carrierBag.links) {
                        links = carrierBag.links;
                        console.log(`🔗 Found ${links.length} links in carrierBag`);
                    } else {
                        console.log('⚠️ No links collection found in carrierBag');
                    }

                    // Try to get user name from BDO
                    userName = bdo.name || bdo.title || 'My Links';

                } catch (error) {
                    console.error('❌ Failed to fetch user BDO:', error.message);
                    // Continue with empty links array
                }
            } else {
                console.log('❌ Invalid signature');
            }
        } else {
            console.log('ℹ️ No emojicode or authentication provided, showing demo');
        }

        // If no links, show demo links
        if (links.length === 0) {
            links = getDemoLinks();
            userName = 'Demo Links';
        }

        // Limit to 20 links
        const displayLinks = links.slice(0, 20);

        // Generate HTML page
        const html = generateLinkitylinkPage(displayLinks, userName, authenticated, pubKey);

        res.send(html);

    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Linkitylink Error</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        margin: 0;
                        padding: 20px;
                    }
                    .error {
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                        text-align: center;
                    }
                </style>
            </head>
            <body>
                <div class="error">
                    <h1>⚠️ Error</h1>
                    <p>${error.message}</p>
                </div>
            </body>
            </html>
        `);
    }
});

// In-memory mapping of pubKey to metadata for alphanumeric URLs
const bdoMetadataMap = new Map();

// Persistence tracking
let mappingsDirty = false;
let mappingsCounter = 0;
let lastBDOBackup = Date.now();

// File paths
const MAPPINGS_FILE = join(__dirname, 'alphanumeric-mappings.json');

/**
 * Load alphanumeric mappings from filesystem on startup
 */
async function loadMappings() {
    try {
        const fs = await import('fs/promises');
        const data = await fs.readFile(MAPPINGS_FILE, 'utf-8');
        const mappings = JSON.parse(data);

        for (const [pubKey, metadata] of Object.entries(mappings)) {
            bdoMetadataMap.set(pubKey, metadata);
        }

        console.log(`📂 Loaded ${bdoMetadataMap.size} alphanumeric mappings from filesystem`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log('📝 No existing mappings file, starting fresh');
        } else {
            console.error('❌ Error loading mappings:', err.message);
        }
    }
}

/**
 * Save alphanumeric mappings to filesystem (batched)
 */
async function saveMappingsToFilesystem() {
    try {
        const fs = await import('fs/promises');
        const mappings = Object.fromEntries(bdoMetadataMap);
        await fs.writeFile(MAPPINGS_FILE, JSON.stringify(mappings, null, 2), 'utf-8');

        mappingsDirty = false;
        console.log(`💾 Saved ${bdoMetadataMap.size} alphanumeric mappings to filesystem`);
    } catch (err) {
        console.error('❌ Error saving mappings to filesystem:', err.message);
    }
}

/**
 * Backup alphanumeric mappings to BDO service (hourly)
 */
async function backupMappingsToBDO() {
    try {
        console.log('☁️ Backing up alphanumeric mappings to BDO service...');

        const mappings = Object.fromEntries(bdoMetadataMap);

        // Generate temporary keys for backup BDO
        const saveKeys = (keys) => { backupKeys = keys; };
        const getKeys = () => backupKeys;
        let backupKeys = null;

        const keys = await sessionless.generateKeys(saveKeys, getKeys);

        // Create backup BDO
        const backupBDO = {
            title: 'Linkitylink Alphanumeric Mappings Backup',
            type: 'linkitylink-backup',
            mappings: mappings,
            mappingCount: bdoMetadataMap.size,
            backedUpAt: new Date().toISOString()
        };

        const hash = 'Linkitylink-System';
        await bdoLib.createUser(hash, backupBDO, saveKeys, getKeys);

        lastBDOBackup = Date.now();
        console.log(`☁️ Backed up ${bdoMetadataMap.size} mappings to BDO service`);
    } catch (err) {
        console.error('❌ Error backing up to BDO:', err.message);
    }
}

/**
 * Mark mappings as dirty and potentially trigger save
 */
function markMappingsDirty() {
    mappingsDirty = true;
    mappingsCounter++;

    // Batch save every 10 creates
    if (mappingsCounter >= 10) {
        mappingsCounter = 0;
        saveMappingsToFilesystem();
    }
}

// Periodic save timer (every 10 minutes if dirty)
setInterval(() => {
    if (mappingsDirty) {
        console.log('⏰ 10-minute timer: Saving dirty mappings...');
        saveMappingsToFilesystem();
    }
}, 10 * 60 * 1000); // 10 minutes

// Hourly BDO backup timer
setInterval(() => {
    const hoursSinceBackup = (Date.now() - lastBDOBackup) / (1000 * 60 * 60);
    if (hoursSinceBackup >= 1 && bdoMetadataMap.size > 0) {
        console.log('⏰ 1-hour timer: Backing up to BDO...');
        backupMappingsToBDO();
    }
}, 60 * 60 * 1000); // 1 hour

// Load mappings on startup
loadMappings();

/**
 * Alphanumeric path route - /t/:identifier
 * Provides shareable alphanumeric URLs using pubKey (first 16 chars)
 */
app.get('/t/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;

        console.log(`🔗 Fetching Linkitylink by identifier: ${identifier}`);

        // Look up full pubKey from identifier
        let pubKey = null;
        for (const [key, metadata] of bdoMetadataMap.entries()) {
            if (key.startsWith(identifier)) {
                pubKey = key;
                break;
            }
        }

        if (!pubKey) {
            throw new Error('Tapestry not found. Identifier may have expired.');
        }

        // Get emojicode from metadata
        const metadata = bdoMetadataMap.get(pubKey);
        const emojicode = metadata.emojicode;

        console.log(`🔗 Found emojicode: ${emojicode}`);

        let links = [];
        let userName = 'Anonymous';

        try {
            // Fetch BDO by emojicode (same as emojicode route)
            const linkHubBDO = await bdoLib.getBDOByEmojicode(emojicode);

            console.log('📦 Linkitylink BDO fetched:', JSON.stringify(linkHubBDO).substring(0, 200));

            // Extract links from BDO data
            const bdoData = linkHubBDO.bdo || linkHubBDO;

            if (bdoData.links && Array.isArray(bdoData.links)) {
                links = bdoData.links;
                console.log(`🔗 Found ${links.length} links in Linkitylink BDO`);
            } else {
                console.log('⚠️ No links array found in Linkitylink BDO');
            }

            // Get user name from BDO
            userName = bdoData.title || bdoData.name || 'My Links';

        } catch (error) {
            console.error('❌ Failed to fetch Linkitylink BDO:', error.message);
            // Continue with empty links array
        }

        // If no links, show demo links
        if (links.length === 0) {
            links = getDemoLinks();
            userName = 'Demo Links';
        }

        // Limit to 20 links
        const displayLinks = links.slice(0, 20);

        // Generate HTML page
        const html = generateLinkitylinkPage(displayLinks, userName, false, null);

        res.send(html);

    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Linkitylink Error</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        margin: 0;
                        padding: 20px;
                    }
                    .error {
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                        text-align: center;
                    }
                </style>
            </head>
            <body>
                <div class="error">
                    <h1>⚠️ Error</h1>
                    <p>${error.message}</p>
                </div>
            </body>
            </html>
        `);
    }
});

/**
 * Generate the main Linkitylink HTML page
 */
function generateLinkitylinkPage(links, userName, authenticated, pubKey) {
    const linkCount = links.length;
    const svgTemplate = chooseSVGTemplate(linkCount);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${userName} - Linkitylink</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 40px 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
        }

        .header h1 {
            color: white;
            font-size: 2.5rem;
            margin-bottom: 10px;
            text-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }

        .header .badge {
            display: inline-block;
            background: rgba(255,255,255,0.2);
            color: white;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.9rem;
            margin-top: 10px;
        }

        .links-container {
            max-width: 600px;
            width: 100%;
            margin-bottom: 40px;
        }

        .link-card {
            background: white;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 15px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            transition: transform 0.2s, box-shadow 0.2s;
            cursor: pointer;
            text-decoration: none;
            display: block;
        }

        .link-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 30px rgba(0,0,0,0.15);
        }

        .link-card .title {
            font-size: 1.2rem;
            font-weight: 600;
            color: #333;
            margin-bottom: 5px;
        }

        .link-card .url {
            font-size: 0.9rem;
            color: #666;
            word-break: break-all;
        }

        .svg-container {
            max-width: 800px;
            width: 100%;
            margin-bottom: 40px;
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }

        .cta-container {
            text-align: center;
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            padding: 40px;
            max-width: 600px;
            width: 100%;
            backdrop-filter: blur(10px);
        }

        .cta-container h2 {
            color: white;
            margin-bottom: 20px;
            font-size: 1.8rem;
        }

        .cta-container p {
            color: rgba(255,255,255,0.9);
            margin-bottom: 25px;
            font-size: 1.1rem;
            line-height: 1.6;
        }

        .cta-button {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            padding: 15px 40px;
            border-radius: 30px;
            text-decoration: none;
            font-weight: 600;
            font-size: 1.1rem;
            display: inline-block;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 4px 20px rgba(16, 185, 129, 0.3);
        }

        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 30px rgba(16, 185, 129, 0.4);
        }

        .footer {
            margin-top: 40px;
            text-align: center;
            color: rgba(255,255,255,0.7);
            font-size: 0.9rem;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${userName}</h1>
        ${authenticated ? '<div class="badge">🔐 Authenticated</div>' : '<div class="badge">👁️ Demo Mode</div>'}
    </div>

    <div class="svg-container">
        ${svgTemplate(links)}
    </div>

    <div class="cta-container">
        <h2>✨ Weave Your Own Linkitylink</h2>
        <p>Cast the Linkitylink enchantment to create your mystical link tapestry. Visit The Enchantment Emporium in The Advancement app.</p>
        <a href="#purchase" class="cta-button" onclick="handlePurchase()">
            Visit The Enchantment Emporium
        </a>
        <p style="font-size: 0.9rem; margin-top: 20px; opacity: 0.8;">
            ✨ Privacy-first • 🔐 Cryptographically secure • 🎨 Mystically beautiful
        </p>
    </div>

    <div class="footer">
        <p>Woven by <strong>Planet Nine</strong></p>
        <p style="margin-top: 5px;">The Enchantment Emporium • Linkitylink Tapestries</p>
    </div>

    <script>
        function handlePurchase() {
            // TODO: Implement Enchantment Emporium integration
            alert('Visit The Enchantment Emporium in The Advancement app to cast the Linkitylink enchantment!');
            console.log('Redirecting to Enchantment Emporium');

            // Future implementation:
            // 1. Deep link to The Advancement app
            // 2. Open Enchantment Emporium
            // 3. Show Linkitylink enchantment
            // 4. Guide user through enchantment casting
        }

        // Make links clickable
        document.querySelectorAll('.link-card').forEach(card => {
            card.addEventListener('click', function(e) {
                const url = this.dataset.url;
                if (url) {
                    window.open(url, '_blank');
                }
            });
        });
    </script>
</body>
</html>`;
}

/**
 * Get social media icon path for SVG
 */
function getSocialIcon(type) {
    const iconType = type.toUpperCase();
    const icons = {
        INSTAGRAM: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z',
        TIKTOK: 'M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-5.2 1.74 2.89 2.89 0 012.31-4.64 2.93 2.93 0 01.88.13V9.4a6.84 6.84 0 00-1-.05A6.33 6.33 0 005 20.1a6.34 6.34 0 0010.86-4.43v-7a8.16 8.16 0 004.77 1.52v-3.4a4.85 4.85 0 01-1-.1z',
        YOUTUBE: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
        TWITTER: 'M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z',
        FACEBOOK: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
        LINKEDIN: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
        GITHUB: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'
    };
    return icons[iconType] || icons.INSTAGRAM; // Default to Instagram if unknown
}

/**
 * Generate SoMa (Social Media) section with icons
 */
function generateSoMaSection(socialLinks, yPosition) {
    if (!socialLinks || socialLinks.length === 0) return '';

    const iconSize = 32;
    const iconSpacing = 50;
    const startX = 350 - ((socialLinks.length * iconSpacing) / 2);

    const socialIcons = socialLinks.map((link, index) => {
        const x = startX + (index * iconSpacing);
        const iconPath = getSocialIcon(link.title);
        const url = escapeXML(link.url || '#');

        return `
        <a href="${url}" target="_blank">
            <g transform="translate(${x}, ${yPosition})">
                <circle cx="16" cy="16" r="18" fill="rgba(167, 139, 250, 0.1)"
                        stroke="#a78bfa" stroke-width="1" opacity="0.6"/>
                <path d="${iconPath}" fill="#a78bfa" opacity="0.8"
                      transform="scale(0.65) translate(4, 4)"
                      style="filter: drop-shadow(0 0 4px #a78bfa);"/>
            </g>
        </a>`;
    }).join('\n');

    return `
    <text x="350" y="${yPosition - 15}" fill="#a78bfa" font-size="16" font-weight="bold"
          text-anchor="middle" opacity="0.7"
          style="filter: drop-shadow(0 0 6px #a78bfa);">
        SoMa:
    </text>
    ${socialIcons}`;
}

/**
 * Choose SVG template based on link count (regular links only)
 */
function chooseSVGTemplate(linkCount) {
    if (linkCount <= 6) {
        return generateCompactSVG;
    } else if (linkCount <= 13) {
        return generateGridSVG;
    } else {
        return generateDenseSVG;
    }
}

/**
 * Template 1: Compact layout (1-6 links)
 * Large cards, vertical stack - DARK MODE WITH GLOW
 */
function generateCompactSVG(links) {
    // Separate regular links from social links
    const regularLinks = links.filter(link => !link.isSocial);
    const socialLinks = links.filter(link => link.isSocial);

    const baseLinkHeight = regularLinks.length * 110 + 60;
    const somaHeight = socialLinks.length > 0 ? 100 : 0;
    const height = Math.max(400, baseLinkHeight + somaHeight);

    const linkElements = regularLinks.map((link, index) => {
        const y = 60 + (index * 110);
        const title = escapeXML(link.title || 'Untitled');
        const url = escapeXML(link.url || '#');
        const truncatedTitle = title.length > 30 ? title.substring(0, 30) + '...' : title;

        // Magical glowing gradients
        const gradients = [
            ['#10b981', '#059669'],  // Emerald glow
            ['#3b82f6', '#2563eb'],  // Sapphire glow
            ['#8b5cf6', '#7c3aed'],  // Amethyst glow
            ['#ec4899', '#db2777'],  // Ruby glow
            ['#fbbf24', '#f59e0b'],  // Topaz glow
            ['#06b6d4', '#0891b2']   // Aquamarine glow
        ];
        const gradient = gradients[index % gradients.length];
        const gradId = `grad${index}`;
        const glowId = `glow${index}`;

        return `
        <defs>
            <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:${gradient[0]};stop-opacity:1" />
                <stop offset="100%" style="stop-color:${gradient[1]};stop-opacity:1" />
            </linearGradient>
            <filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="8" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>

        <a href="${url}" target="_blank">
            <g filter="url(#${glowId})">
                <rect x="50" y="${y}" width="600" height="90" rx="15"
                      fill="url(#${gradId})" opacity="0.15"/>
                <rect x="50" y="${y}" width="600" height="90" rx="15"
                      fill="none" stroke="url(#${gradId})" stroke-width="2" opacity="0.8"/>
            </g>
            <text x="90" y="${y + 40}" fill="${gradient[0]}" font-size="20" font-weight="bold"
                  style="filter: drop-shadow(0 0 8px ${gradient[0]});">${truncatedTitle}</text>
            <text x="90" y="${y + 65}" fill="rgba(167, 139, 250, 0.7)" font-size="14">✨ Tap to open</text>
            <text x="600" y="${y + 50}" fill="${gradient[0]}" font-size="30"
                  style="filter: drop-shadow(0 0 6px ${gradient[0]});">→</text>
        </a>`;
    }).join('\n');

    return `
<svg width="700" height="${height}" viewBox="0 0 700 ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <radialGradient id="bgGrad" cx="50%" cy="50%">
            <stop offset="0%" style="stop-color:#1a0033;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#0a001a;stop-opacity:1" />
        </radialGradient>
    </defs>

    <rect width="700" height="${height}" fill="url(#bgGrad)"/>

    <!-- Magical particles -->
    <circle cx="100" cy="20" r="2" fill="#fbbf24" opacity="0.6">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="3s" repeatCount="indefinite"/>
    </circle>
    <circle cx="600" cy="30" r="1.5" fill="#a78bfa" opacity="0.5">
        <animate attributeName="opacity" values="0.2;0.7;0.2" dur="4s" repeatCount="indefinite"/>
    </circle>
    <circle cx="350" cy="15" r="1" fill="#10b981" opacity="0.4">
        <animate attributeName="opacity" values="0.2;0.6;0.2" dur="5s" repeatCount="indefinite"/>
    </circle>

    <text x="350" y="35" fill="#fbbf24" font-size="24" font-weight="bold" text-anchor="middle"
          style="filter: drop-shadow(0 0 10px #fbbf24);">
        ✨ My Links ✨
    </text>

    ${linkElements}

    <!-- Social Media Section (SoMa) -->
    ${socialLinks.length > 0 ? generateSoMaSection(socialLinks, baseLinkHeight + 50) : ''}
</svg>`;
}

/**
 * Template 2: Grid layout (7-13 links)
 * 2-column grid with medium cards - DARK MODE WITH GLOW
 */
function generateGridSVG(links) {
    // Separate regular links from social links
    const regularLinks = links.filter(link => !link.isSocial);
    const socialLinks = links.filter(link => link.isSocial);

    const rows = Math.ceil(regularLinks.length / 2);
    const baseLinkHeight = rows * 100 + 100;
    const somaHeight = socialLinks.length > 0 ? 100 : 0;
    const height = Math.max(400, baseLinkHeight + somaHeight);

    const linkElements = regularLinks.map((link, index) => {
        const col = index % 2;
        const row = Math.floor(index / 2);
        const x = col === 0 ? 40 : 370;
        const y = 80 + (row * 100);

        const title = escapeXML(link.title || 'Untitled');
        const url = escapeXML(link.url || '#');
        const truncatedTitle = title.length > 15 ? title.substring(0, 15) + '...' : title;

        const gradients = [
            ['#10b981', '#059669'],  // Emerald
            ['#3b82f6', '#2563eb'],  // Sapphire
            ['#8b5cf6', '#7c3aed'],  // Amethyst
            ['#ec4899', '#db2777'],  // Ruby
            ['#fbbf24', '#f59e0b'],  // Topaz
            ['#06b6d4', '#0891b2']   // Aquamarine
        ];
        const gradient = gradients[index % gradients.length];
        const gradId = `grad${index}`;
        const glowId = `glow${index}`;

        return `
        <defs>
            <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:${gradient[0]};stop-opacity:1" />
                <stop offset="100%" style="stop-color:${gradient[1]};stop-opacity:1" />
            </linearGradient>
            <filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="6" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>

        <a href="${url}" target="_blank">
            <g filter="url(#${glowId})">
                <rect x="${x}" y="${y}" width="290" height="80" rx="12"
                      fill="url(#${gradId})" opacity="0.15"/>
                <rect x="${x}" y="${y}" width="290" height="80" rx="12"
                      fill="none" stroke="url(#${gradId})" stroke-width="2" opacity="0.8"/>
            </g>
            <text x="${x + 20}" y="${y + 35}" fill="${gradient[0]}" font-size="16" font-weight="bold"
                  style="filter: drop-shadow(0 0 6px ${gradient[0]});">${truncatedTitle}</text>
            <text x="${x + 20}" y="${y + 55}" fill="rgba(167, 139, 250, 0.7)" font-size="12">✨ Click</text>
        </a>`;
    }).join('\n');

    return `
<svg width="700" height="${height}" viewBox="0 0 700 ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <radialGradient id="bgGrad" cx="50%" cy="50%">
            <stop offset="0%" style="stop-color:#1a0033;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#0a001a;stop-opacity:1" />
        </radialGradient>
    </defs>

    <rect width="700" height="${height}" fill="url(#bgGrad)"/>

    <!-- Magical particles -->
    <circle cx="120" cy="25" r="2" fill="#fbbf24" opacity="0.6">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="3s" repeatCount="indefinite"/>
    </circle>
    <circle cx="580" cy="35" r="1.5" fill="#a78bfa" opacity="0.5">
        <animate attributeName="opacity" values="0.2;0.7;0.2" dur="4s" repeatCount="indefinite"/>
    </circle>
    <circle cx="350" cy="20" r="1" fill="#10b981" opacity="0.4">
        <animate attributeName="opacity" values="0.2;0.6;0.2" dur="5s" repeatCount="indefinite"/>
    </circle>
    <circle cx="200" cy="30" r="1.5" fill="#ec4899" opacity="0.5">
        <animate attributeName="opacity" values="0.3;0.7;0.3" dur="3.5s" repeatCount="indefinite"/>
    </circle>

    <text x="350" y="40" fill="#fbbf24" font-size="24" font-weight="bold" text-anchor="middle"
          style="filter: drop-shadow(0 0 10px #fbbf24);">
        ✨ My Links ✨
    </text>

    ${linkElements}

    <!-- Social Media Section (SoMa) -->
    ${socialLinks.length > 0 ? generateSoMaSection(socialLinks, baseLinkHeight + 20) : ''}
</svg>`;
}

/**
 * Template 3: Dense layout (14-20 links)
 * 3-column grid with compact cards - DARK MODE WITH GLOW
 */
function generateDenseSVG(links) {
    // Separate regular links from social links
    const regularLinks = links.filter(link => !link.isSocial);
    const socialLinks = links.filter(link => link.isSocial);

    const rows = Math.ceil(regularLinks.length / 3);
    const baseLinkHeight = rows * 80 + 100;
    const somaHeight = socialLinks.length > 0 ? 100 : 0;
    const height = Math.max(400, baseLinkHeight + somaHeight);

    const linkElements = regularLinks.map((link, index) => {
        const col = index % 3;
        const row = Math.floor(index / 3);
        const x = 30 + (col * 220);
        const y = 80 + (row * 80);

        const title = escapeXML(link.title || 'Untitled');
        const url = escapeXML(link.url || '#');
        const truncatedTitle = title.length > 12 ? title.substring(0, 12) + '...' : title;

        const gradients = [
            ['#10b981', '#059669'],  // Emerald
            ['#3b82f6', '#2563eb'],  // Sapphire
            ['#8b5cf6', '#7c3aed'],  // Amethyst
            ['#ec4899', '#db2777'],  // Ruby
            ['#fbbf24', '#f59e0b'],  // Topaz
            ['#06b6d4', '#0891b2']   // Aquamarine
        ];
        const gradient = gradients[index % gradients.length];
        const gradId = `grad${index}`;
        const glowId = `glow${index}`;

        return `
        <defs>
            <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:${gradient[0]};stop-opacity:1" />
                <stop offset="100%" style="stop-color:${gradient[1]};stop-opacity:1" />
            </linearGradient>
            <filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="5" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>

        <a href="${url}" target="_blank">
            <g filter="url(#${glowId})">
                <rect x="${x}" y="${y}" width="190" height="65" rx="10"
                      fill="url(#${gradId})" opacity="0.15"/>
                <rect x="${x}" y="${y}" width="190" height="65" rx="10"
                      fill="none" stroke="url(#${gradId})" stroke-width="2" opacity="0.8"/>
            </g>
            <text x="${x + 15}" y="${y + 30}" fill="${gradient[0]}" font-size="14" font-weight="bold"
                  style="filter: drop-shadow(0 0 5px ${gradient[0]});">${truncatedTitle}</text>
            <text x="${x + 15}" y="${y + 48}" fill="rgba(167, 139, 250, 0.7)" font-size="11">✨</text>
        </a>`;
    }).join('\n');

    return `
<svg width="700" height="${height}" viewBox="0 0 700 ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <radialGradient id="bgGrad" cx="50%" cy="50%">
            <stop offset="0%" style="stop-color:#1a0033;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#0a001a;stop-opacity:1" />
        </radialGradient>
    </defs>

    <rect width="700" height="${height}" fill="url(#bgGrad)"/>

    <!-- Magical particles -->
    <circle cx="100" cy="25" r="2" fill="#fbbf24" opacity="0.6">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="3s" repeatCount="indefinite"/>
    </circle>
    <circle cx="350" cy="20" r="1.5" fill="#a78bfa" opacity="0.5">
        <animate attributeName="opacity" values="0.2;0.7;0.2" dur="4s" repeatCount="indefinite"/>
    </circle>
    <circle cx="600" cy="30" r="1" fill="#10b981" opacity="0.4">
        <animate attributeName="opacity" values="0.2;0.6;0.2" dur="5s" repeatCount="indefinite"/>
    </circle>
    <circle cx="200" cy="35" r="1.5" fill="#ec4899" opacity="0.5">
        <animate attributeName="opacity" values="0.3;0.7;0.3" dur="3.5s" repeatCount="indefinite"/>
    </circle>
    <circle cx="500" cy="28" r="1" fill="#06b6d4" opacity="0.4">
        <animate attributeName="opacity" values="0.2;0.6;0.2" dur="4.5s" repeatCount="indefinite"/>
    </circle>

    <text x="350" y="40" fill="#fbbf24" font-size="22" font-weight="bold" text-anchor="middle"
          style="filter: drop-shadow(0 0 10px #fbbf24);">
        ✨ My Links ✨
    </text>

    ${linkElements}

    <!-- Social Media Section (SoMa) -->
    ${socialLinks.length > 0 ? generateSoMaSection(socialLinks, baseLinkHeight + 10) : ''}
</svg>`;
}

/**
 * Get demo links for unauthenticated users
 */
function getDemoLinks() {
    return [
        { title: 'GitHub', url: 'https://github.com/planet-nine-app' },
        { title: 'Planet Nine', url: 'https://planetnine.app' },
        { title: 'Documentation', url: 'https://docs.planetnine.app' },
        { title: 'Twitter', url: 'https://twitter.com/planetnine' },
        { title: 'Discord', url: 'https://discord.gg/planetnine' },
        { title: 'Blog', url: 'https://blog.planetnine.app' }
    ];
}

/**
 * Escape XML special characters
 */
function escapeXML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Get or create user account
 * Returns: { uuid, pubKey, keys, carrierBag }
 */
async function getOrCreateUser(req) {
    // Check if user already has account in session
    if (req.session.userUUID && req.session.userPubKey && req.session.userKeys && req.session.carrierBag) {
        console.log(`✅ Existing user session: ${req.session.userUUID}`);
        return {
            uuid: req.session.userUUID,
            pubKey: req.session.userPubKey,
            keys: req.session.userKeys,
            carrierBag: req.session.carrierBag
        };
    }

    // Create new user (session-based for now, Fount integration later)
    console.log('🆕 Creating new user session...');

    // Generate sessionless keys for user
    let userKeys;
    const saveKeys = (keys) => { userKeys = keys; };
    const getKeys = () => userKeys;

    const keys = await sessionless.generateKeys(saveKeys, getKeys);
    const pubKey = keys.pubKey;

    console.log(`🔑 Generated user keys: ${pubKey.substring(0, 16)}...`);

    // Generate a simple UUID for the user
    const userUUID = `user_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    // Initialize empty carrierBag
    const carrierBag = {
        linkitylink: []  // Will store tapestry references
    };

    console.log(`✅ User session created: ${userUUID}`);

    // Store in session
    req.session.userUUID = userUUID;
    req.session.userPubKey = pubKey;
    req.session.userKeys = userKeys;
    req.session.carrierBag = carrierBag;

    // Save session
    await new Promise((resolve, reject) => {
        req.session.save((err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    console.log(`✅ User session saved`);

    return { uuid: userUUID, pubKey, keys: userKeys, carrierBag };
}

/**
 * Add tapestry reference to user's session carrierBag
 */
async function addTapestryToUser(req, tapestryData) {
    try {
        console.log(`💼 Adding tapestry to user session carrierBag...`);

        // Get current carrierBag from session
        const carrierBag = req.session.carrierBag || { linkitylink: [] };

        // Add tapestry reference
        if (!carrierBag.linkitylink) {
            carrierBag.linkitylink = [];
        }

        carrierBag.linkitylink.unshift({  // Add to beginning
            bdoUUID: tapestryData.bdoUUID,
            emojicode: tapestryData.emojicode,
            pubKey: tapestryData.pubKey,
            title: tapestryData.title,
            linkCount: tapestryData.linkCount,
            createdAt: tapestryData.createdAt
        });

        // Update session
        req.session.carrierBag = carrierBag;

        // Save session
        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        console.log(`✅ Tapestry added to carrierBag (${carrierBag.linkitylink.length} total)`);
        return { success: true };

    } catch (error) {
        console.error('❌ Failed to add tapestry to carrierBag:', error);
        return { success: false, error: error.message };
    }
}

/**
 * GET /create - Serve create page
 */
app.get('/create', async (req, res) => {
    const fs = await import('fs/promises');
    let createPage = await fs.readFile(join(__dirname, 'public', 'create.html'), 'utf-8');

    // Inject base path for proper asset loading when proxied
    createPage = injectBasePath(createPage);

    // Inject app purchase configuration
    const configScript = `
        <script>
            window.LINKITYLINK_CONFIG = {
                enableAppPurchase: ${ENABLE_APP_PURCHASE}
            };
        </script>
    `;

    // Insert config script before closing </head> tag
    createPage = createPage.replace('</head>', `${configScript}</head>`);

    res.send(createPage);
});

/**
 * POST /create - Create Linkitylink BDO
 *
 * Flow:
 * 1. Get or create user account (Fount user with session)
 * 2. Receive raw BDO data with links from client
 * 3. Generate composite SVG based on link count
 * 4. Add svgContent to BDO
 * 5. Create tapestry BDO in BDO service
 * 6. Add tapestry reference to user's carrierBag
 * 7. Return emojicode to client
 *
 * Body:
 * {
 *   "title": "My Links",
 *   "links": [{"title": "...", "url": "..."}, ...],
 *   "source": "linktree" | "manual" (optional),
 *   "sourceUrl": "https://..." (optional),
 *   "style": "stunning" | "dazzling" | ... (optional),
 *   "template": "Sunset" | "Ocean" | ... (optional)
 * }
 */
app.post('/create', async (req, res) => {
    try {
        console.log('🎨 Creating Linkitylink BDO...');

        // Get or create user account
        const user = await getOrCreateUser(req);

        const { title, links, source, sourceUrl, style, template } = req.body;

        // Validate input
        if (!links || !Array.isArray(links) || links.length === 0) {
            return res.status(400).json({
                error: 'Missing or invalid links array'
            });
        }

        console.log(`📊 Received ${links.length} links`);
        console.log(`📝 Title: ${title || 'My Links'}`);

        // Generate composite SVG
        const linkCount = links.length;
        const svgTemplate = chooseSVGTemplate(linkCount);
        const svgContent = svgTemplate(links);

        console.log(`✅ Generated SVG (${svgContent.length} characters)`);

        // Build complete BDO with svgContent
        const linkitylinkBDO = {
            title: title || 'My Links',
            type: 'linkitylink',
            svgContent: svgContent,  // Added by Linkitylink!
            links: links,
            createdAt: new Date().toISOString()
        };

        // Add optional metadata
        if (source) linkitylinkBDO.source = source;
        if (sourceUrl) linkitylinkBDO.sourceUrl = sourceUrl;

        // Generate temporary keys for BDO
        const saveKeys = (keys) => { tempKeys = keys; };
        const getKeys = () => tempKeys;
        let tempKeys = null;

        const keys = await sessionless.generateKeys(saveKeys, getKeys);
        const pubKey = keys.pubKey;

        console.log(`🔑 Generated keys: ${pubKey.substring(0, 16)}...`);

        // Create BDO via bdo-js (handles signing automatically)
        const hash = 'Linkitylink';
        console.log(`🌐 Creating BDO with hash: ${hash}`);

        const bdoUUID = await bdoLib.createUser(hash, linkitylinkBDO, saveKeys, getKeys);
        console.log(`✅ BDO created: ${bdoUUID}`);

        // Make BDO public to get emojicode (using bdo-js)
        console.log(`🌍 Making BDO public...`);
        const updatedBDO = await bdoLib.updateBDO(bdoUUID, hash, linkitylinkBDO, true);
        const emojicode = updatedBDO.emojiShortcode;

        console.log(`✅ Emojicode generated: ${emojicode}`);

        // Store pubKey metadata for alphanumeric URL lookup
        bdoMetadataMap.set(pubKey, {
            uuid: bdoUUID,
            emojicode: emojicode,
            createdAt: new Date()
        });
        markMappingsDirty();

        // Add tapestry to user's carrierBag
        await addTapestryToUser(req, {
            bdoUUID: bdoUUID,
            emojicode: emojicode,
            pubKey: pubKey,
            title: title || 'My Tapestry',
            linkCount: links.length,
            createdAt: new Date().toISOString()
        });

        // Increment sales counter
        await incrementSales();

        // Return identifiers only - let client construct URLs
        res.json({
            success: true,
            uuid: bdoUUID,
            pubKey: pubKey,
            emojicode: emojicode,
            userUUID: user.uuid  // Include user UUID for reference
        });

    } catch (error) {
        console.error('❌ Error creating Linkitylink:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * GET /stats - Get server statistics
 *
 * Returns total sales and other stats
 */
app.get('/stats', async (req, res) => {
    try {
        const stats = await loadStats();
        res.json({
            success: true,
            totalSales: stats.totalSales,
            createdAt: stats.createdAt,
            lastUpdated: stats.lastUpdated
        });
    } catch (error) {
        console.error('❌ Error loading stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load statistics'
        });
    }
});

/**
 * GET /my-tapestries - Get user's tapestries
 *
 * Returns all tapestries created by the current user from session
 */
app.get('/my-tapestries', async (req, res) => {
    try {
        // Check if user has session
        if (!req.session.userUUID) {
            return res.json({
                success: true,
                tapestries: [],
                message: 'No user session found'
            });
        }

        console.log(`📋 Fetching tapestries for user ${req.session.userUUID}`);

        // Get carrierBag from session
        const carrierBag = req.session.carrierBag || {};
        const tapestries = carrierBag.linkitylink || [];

        console.log(`✅ Found ${tapestries.length} tapestries`);

        res.json({
            success: true,
            tapestries: tapestries,
            userUUID: req.session.userUUID
        });

    } catch (error) {
        console.error('❌ Error fetching tapestries:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /parse-linktree - Parse links from a Linktree URL using lightweight HTTP fetch
 *
 * Linktree embeds all data in __NEXT_DATA__ script tag in initial HTML response
 * No browser needed - just fetch HTML and parse the JSON
 * Returns just the links array without creating any BDOs
 */
app.post('/parse-linktree', async (req, res) => {
    try {
        const { url } = req.body;

        console.log(`🌐 Parsing Linktree URL: ${url}`);

        // Validate URL
        if (!url || !url.includes('linktr.ee')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Linktree URL. Please enter a linktr.ee URL.'
            });
        }

        console.log('📄 Fetching Linktree page...');

        // Fetch HTML with realistic User-Agent
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) {
            return res.status(400).json({
                success: false,
                error: `Failed to fetch Linktree page: ${response.statusText}`
            });
        }

        const html = await response.text();

        console.log('🔍 Extracting __NEXT_DATA__ from HTML...');

        // Parse __NEXT_DATA__ from HTML (Linktree embeds data in script tag)
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);

        if (!nextDataMatch) {
            return res.status(400).json({
                success: false,
                error: 'Could not find __NEXT_DATA__ in Linktree page. The page structure may have changed.'
            });
        }

        const nextData = JSON.parse(nextDataMatch[1]);
        const pageProps = nextData.props?.pageProps?.account;

        if (!pageProps || !pageProps.links) {
            return res.status(400).json({
                success: false,
                error: 'No links found on this Linktree page.'
            });
        }

        // Extract regular links
        const links = pageProps.links.map(link => ({
            title: link.title,
            url: link.url
        }));

        // Extract social links (Instagram, TikTok, YouTube, etc.)
        const socialLinks = (pageProps.socialLinks || []).map(social => ({
            title: social.type.charAt(0) + social.type.slice(1).toLowerCase(), // Capitalize type
            url: social.url,
            isSocial: true // Mark as social link
        }));

        const username = pageProps.username || 'Unknown';

        console.log(`✅ Extracted ${links.length} links + ${socialLinks.length} social links from @${username}'s Linktree`);

        res.json({
            success: true,
            links: [...links, ...socialLinks], // Combine regular and social links
            username: username,
            source: 'linktree'
        });

    } catch (error) {
        console.error('❌ Error parsing Linktree:', error);

        // Make sure browser is closed
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                console.error('Error closing browser:', closeError);
            }
        }

        res.status(500).json({
            success: false,
            error: 'Failed to parse Linktree page. Please try again.'
        });
    }
});

/**
 * POST /create-payment-intent - Create Stripe payment intent via Addie
 *
 * Creates a $20 payment intent for Linkitylink tapestry purchase.
 * Fetches relevantBDOs and extracts their payees for payment splits.
 */
app.post('/create-payment-intent', async (req, res) => {
    try {
        console.log('💳 Creating payment intent via Addie...');

        // Get relevantBDOs using middleware helper (handles body + session)
        const relevantBDOs = getRelevantBDOs(req);
        logRelevantBDOs(relevantBDOs, '📦 relevantBDOs for payment');

        // Fetch BDOs and extract payees
        const payees = await fetchAndExtractPayees(relevantBDOs);
        logPayees(payees, '💰 Payees from relevantBDOs');

        // Get or create user session
        const user = await getOrCreateUser(req);

        // Set up saveKeys/getKeys for addie-js (same pattern as bdo-js)
        const saveKeys = (keys) => { user.keys = keys; };
        const getKeys = () => user.keys;

        // Create/get Addie user if needed
        if (!user.addieUUID) {
            console.log('📝 Creating Addie user...');

            // Create Addie user via addie-js SDK
            const addieUUID = await addieLib.createUser(saveKeys, getKeys);
            user.addieUUID = addieUUID;

            // Save to session
            req.session.addieUUID = addieUUID;
            await new Promise((resolve, reject) => {
                req.session.save((err) => err ? reject(err) : resolve());
            });

            console.log(`✅ Addie user created: ${user.addieUUID}`);
        }

        // Create payment intent via addie-js SDK
        const amount = 2000; // $20.00
        const currency = 'usd';

        console.log(`💰 Creating payment intent for $${amount/100}...`);

        // Set up sessionless.getKeys for addie-js to use for signing
        sessionless.getKeys = getKeys;

        // Convert relevantBDOs to Stripe metadata format (for record keeping)
        const stripeMetadata = toStripeMetadata(relevantBDOs);

        let intentData;

        // Use getPaymentIntent with payees if we have any, otherwise use without splits
        if (payees.length > 0) {
            console.log(`💰 Creating payment intent WITH ${payees.length} payees...`);
            intentData = await addieLib.getPaymentIntent(
                user.addieUUID,
                'stripe',
                amount,
                currency,
                payees
            );
        } else {
            console.log('💰 Creating payment intent WITHOUT payees...');
            intentData = await addieLib.getPaymentIntentWithoutSplits(
                user.addieUUID,
                'stripe',
                amount,
                currency
            );
        }

        console.log(`✅ Payment intent created`);
        if (Object.keys(stripeMetadata).length > 0) {
            console.log('📦 Stripe metadata prepared:', Object.keys(stripeMetadata).length, 'keys');
        }

        res.json({
            success: true,
            clientSecret: intentData.paymentIntent,  // This is the client_secret
            publishableKey: intentData.publishableKey,
            customer: intentData.customer,
            ephemeralKey: intentData.ephemeralKey,
            payeesIncluded: payees.length  // Let client know how many payees were included
        });

    } catch (error) {
        console.error('❌ Error creating payment intent:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /magic/spell/:spellName - MAGIC Protocol Endpoint
 *
 * Handles spell casting for Linkitylink creation with integrated payment processing.
 *
 * Available Spells:
 * - linkitylink: Create tapestry from carrierBag links
 * - glyphtree: Create tapestry from Linktree URL
 */
app.post('/magic/spell/:spellName', async (req, res) => {
    try {
        const { spellName } = req.params;
        const { caster, payload } = req.body;

        console.log(`✨ MAGIC: Casting spell "${spellName}"`);

        // Validate caster authentication
        if (!caster || !caster.pubKey || !caster.timestamp || !caster.signature) {
            return res.status(403).json({
                success: false,
                error: 'Missing caster authentication'
            });
        }

        // Verify caster signature (timestamp + pubKey)
        const message = caster.timestamp + caster.pubKey;
        const isValid = sessionless.verifySignature(caster.signature, message, caster.pubKey);

        if (!isValid) {
            return res.status(403).json({
                success: false,
                error: 'Invalid caster signature'
            });
        }

        // Route to spell resolver
        let result;
        if (spellName === 'linkitylink') {
            result = await resolveLinkitylinkSpell(caster, payload);
        } else if (spellName === 'glyphtree') {
            result = await resolveGlyphtreeSpell(caster, payload);
        } else if (spellName === 'submitLinkitylinkTemplate') {
            result = await resolveSubmitTemplateSpell(caster, payload);
        } else {
            return res.status(404).json({
                success: false,
                error: `Unknown spell: ${spellName}`
            });
        }

        res.json(result);

    } catch (error) {
        console.error('❌ MAGIC spell error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Resolve linkitylink spell
 * Creates tapestry from carrierBag links with payment processing
 */
async function resolveLinkitylinkSpell(caster, payload) {
    console.log('🎨 Resolving linkitylink spell...');

    const { paymentMethod, links, title } = payload;

    // Validate required spell components
    if (!links || !Array.isArray(links) || links.length === 0) {
        return { success: false, error: 'Missing or invalid links array' };
    }

    if (!paymentMethod || (paymentMethod !== 'mp' && paymentMethod !== 'money')) {
        return { success: false, error: 'Invalid payment method (must be mp or money)' };
    }

    // Process payment
    const paymentResult = await processSpellPayment(caster, paymentMethod, 100); // $1.00
    if (!paymentResult.success) {
        return paymentResult;
    }

    // Generate SVG using existing template logic
    const linkCount = links.length;
    const svgTemplate = chooseSVGTemplate(linkCount);
    const svgContent = svgTemplate(links);

    console.log(`✅ Generated SVG (${svgContent.length} characters)`);

    // Build complete BDO with svgContent
    const linkitylinkBDO = {
        title: title || 'My Linkitylink',
        type: 'linkitylink',
        svgContent: svgContent,
        links: links,
        source: 'emporium-spell',
        createdAt: new Date().toISOString()
    };

    // Generate temporary keys for BDO
    const saveKeys = (keys) => { tempKeys = keys; };
    const getKeys = () => tempKeys;
    let tempKeys = null;

    const keys = await sessionless.generateKeys(saveKeys, getKeys);
    const pubKey = keys.pubKey;

    console.log(`🔑 Generated BDO keys: ${pubKey.substring(0, 16)}...`);

    // Create BDO via bdo-js (handles signing automatically)
    const hash = 'Linkitylink';
    console.log(`🌐 Creating BDO with hash: ${hash}`);

    const bdoUUID = await bdoLib.createUser(hash, linkitylinkBDO, saveKeys, getKeys);
    console.log(`✅ BDO created: ${bdoUUID}`);

    // Make BDO public to get emojicode
    console.log(`🌍 Making BDO public...`);
    const updatedBDO = await bdoLib.updateBDO(bdoUUID, hash, linkitylinkBDO, true);
    const emojicode = updatedBDO.emojiShortcode;

    console.log(`✅ Emojicode generated: ${emojicode}`);

    // Save to carrierBag "store" collection
    const carrierBagResult = await saveToCarrierBag(caster.pubKey, 'store', {
        title: linkitylinkBDO.title,
        type: 'linkitylink',
        emojicode: emojicode,
        bdoPubKey: pubKey,
        createdAt: linkitylinkBDO.createdAt
    });

    if (!carrierBagResult.success) {
        console.warn('⚠️ Failed to save to carrierBag, but spell succeeded');
    }

    // Store pubKey metadata for alphanumeric URL lookup
    bdoMetadataMap.set(pubKey, {
        uuid: bdoUUID,
        emojicode: emojicode,
        createdAt: new Date()
    });
    markMappingsDirty();

    // Return identifiers only - let client construct URLs
    return {
        success: true,
        uuid: bdoUUID,
        pubKey: pubKey,
        emojicode: emojicode,
        payment: paymentResult.payment
    };
}

/**
 * Resolve glyphtree spell
 * Creates tapestry from Linktree URL with payment processing
 */
async function resolveGlyphtreeSpell(caster, payload) {
    console.log('🌳 Resolving glyphtree spell...');

    const { paymentMethod, linktreeUrl } = payload;

    // Validate required spell components
    if (!linktreeUrl || !linktreeUrl.includes('linktr.ee')) {
        return { success: false, error: 'Invalid Linktree URL' };
    }

    if (!paymentMethod || (paymentMethod !== 'mp' && paymentMethod !== 'money')) {
        return { success: false, error: 'Invalid payment method (must be mp or money)' };
    }

    // Fetch and parse Linktree page
    console.log(`🌐 Fetching Linktree page: ${linktreeUrl}`);

    const response = await fetch(linktreeUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
    });

    if (!response.ok) {
        return { success: false, error: `Failed to fetch Linktree page: ${response.statusText}` };
    }

    const html = await response.text();

    // Extract __NEXT_DATA__ from page
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
    if (!nextDataMatch) {
        return { success: false, error: 'Could not find __NEXT_DATA__ in Linktree page' };
    }

    const nextData = JSON.parse(nextDataMatch[1]);
    const pageProps = nextData.props?.pageProps?.account;

    if (!pageProps || !pageProps.links) {
        return { success: false, error: 'Invalid Linktree page structure' };
    }

    // Extract regular links
    const links = pageProps.links.map(link => ({
        title: link.title,
        url: link.url
    }));

    // Extract social links (Instagram, TikTok, YouTube, etc.)
    const socialLinks = (pageProps.socialLinks || []).map(social => ({
        title: social.type.charAt(0) + social.type.slice(1).toLowerCase(),
        url: social.url,
        isSocial: true
    }));

    // Combine all links
    const allLinks = [...links, ...socialLinks];

    const title = `${pageProps.username}'s Links` || 'Linktree Import';

    console.log(`✅ Extracted ${links.length} links + ${socialLinks.length} social links from Linktree`);

    // Process payment
    const paymentResult = await processSpellPayment(caster, paymentMethod, 100); // $1.00
    if (!paymentResult.success) {
        return paymentResult;
    }

    // Generate SVG using existing template logic
    const linkCount = allLinks.length;
    const svgTemplate = chooseSVGTemplate(linkCount);
    const svgContent = svgTemplate(allLinks);

    console.log(`✅ Generated SVG (${svgContent.length} characters)`);

    // Build complete BDO with svgContent
    const linkitylinkBDO = {
        title: title,
        type: 'linkitylink',
        svgContent: svgContent,
        links: allLinks, // Include both regular and social links
        source: 'linktree',
        sourceUrl: linktreeUrl,
        createdAt: new Date().toISOString()
    };

    // Generate temporary keys for BDO
    const saveKeys = (keys) => { tempKeys = keys; };
    const getKeys = () => tempKeys;
    let tempKeys = null;

    const keys = await sessionless.generateKeys(saveKeys, getKeys);
    const pubKey = keys.pubKey;

    console.log(`🔑 Generated BDO keys: ${pubKey.substring(0, 16)}...`);

    // Create BDO via bdo-js (handles signing automatically)
    const hash = 'Linkitylink';
    console.log(`🌐 Creating BDO with hash: ${hash}`);

    const bdoUUID = await bdoLib.createUser(hash, linkitylinkBDO, saveKeys, getKeys);
    console.log(`✅ BDO created: ${bdoUUID}`);

    // Make BDO public to get emojicode
    console.log(`🌍 Making BDO public...`);
    const updatedBDO = await bdoLib.updateBDO(bdoUUID, hash, linkitylinkBDO, true);
    const emojicode = updatedBDO.emojiShortcode;

    console.log(`✅ Emojicode generated: ${emojicode}`);

    // Save to carrierBag "store" collection
    const carrierBagResult = await saveToCarrierBag(caster.pubKey, 'store', {
        title: linkitylinkBDO.title,
        type: 'linkitylink',
        emojicode: emojicode,
        bdoPubKey: pubKey,
        sourceUrl: linktreeUrl,
        createdAt: linkitylinkBDO.createdAt
    });

    if (!carrierBagResult.success) {
        console.warn('⚠️ Failed to save to carrierBag, but spell succeeded');
    }

    // Store pubKey metadata for alphanumeric URL lookup
    bdoMetadataMap.set(pubKey, {
        uuid: bdoUUID,
        emojicode: emojicode,
        createdAt: new Date()
    });
    markMappingsDirty();

    // Return identifiers only - let client construct URLs
    return {
        success: true,
        uuid: bdoUUID,
        pubKey: pubKey,
        emojicode: emojicode,
        linkCount: links.length,
        payment: paymentResult.payment
    };
}

/**
 * Process payment for spell casting
 *
 * Note: Word of power validation happens CLIENT-SIDE using SHA256 hash comparison.
 * This function does not validate or require word of power - that check is done
 * in the browser before the spell is cast.
 */
async function processSpellPayment(caster, paymentMethod, amountCents) {
    console.log(`💰 Processing ${paymentMethod} payment...`);

    if (paymentMethod === 'mp') {
        // MP payment through Fount
        // TODO: Call Fount /resolve with deductMP spell
        // For now, return simulated success
        return {
            success: true,
            payment: {
                method: 'mp',
                amount: amountCents / 100,
                message: 'MP payment simulated (TODO: integrate with Fount)'
            }
        };

    } else if (paymentMethod === 'money') {
        // Money payment through Addie
        // TODO: Call Addie /charge-with-saved-method
        // For now, return simulated success
        return {
            success: true,
            payment: {
                method: 'money',
                amount: amountCents / 100,
                message: 'Money payment simulated (TODO: integrate with Addie)'
            }
        };

    } else {
        return {
            success: false,
            error: 'Unknown payment method'
        };
    }
}

/**
 * Save item to user's carrierBag collection
 */
async function saveToCarrierBag(userPubKey, collection, item) {
    console.log(`💼 Saving to carrierBag collection: ${collection}`);

    try {
        // Fetch user's Fount BDO (which contains carrierBag)
        const userBDO = await fountLib.getBDO(userPubKey);
        const bdo = userBDO.bdo || userBDO;
        const carrierBag = bdo.carrierBag || bdo.data?.carrierBag || {};

        // Add item to collection
        if (!carrierBag[collection]) {
            carrierBag[collection] = [];
        }
        carrierBag[collection].push(item);

        // Update carrierBag
        // TODO: This requires authentication - need to handle signing
        // For now, log success but don't actually update
        console.log(`✅ Would save to carrierBag ${collection} collection`);
        console.log(`   Item: ${JSON.stringify(item).substring(0, 100)}...`);

        return { success: true };

    } catch (error) {
        console.error('❌ Failed to save to carrierBag:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Check if a user has admin nineum in the connected base's Fount instance
 *
 * @param {string} pubKey - User's public key
 * @returns {Promise<boolean>} - True if user has admin nineum
 */
async function checkIsAdmin(pubKey) {
    try {
        console.log(`🔑 Checking admin status for pubKey: ${pubKey.substring(0, 16)}...`);

        // Get user UUID from Fount using pubKey
        const userResponse = await fetch(`${FOUNT_BASE_URL}user/pubKey/${pubKey}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!userResponse.ok) {
            console.log(`❌ User not found in Fount: ${userResponse.status}`);
            return false;
        }

        const user = await userResponse.json();
        if (!user || !user.uuid) {
            console.log(`❌ User response missing UUID`);
            return false;
        }

        console.log(`✅ Found user UUID: ${user.uuid}`);

        // Check if user has admin nineum
        const nineumResponse = await fetch(`${FOUNT_BASE_URL}user/${user.uuid}/nineum/admin`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!nineumResponse.ok) {
            console.log(`❌ Failed to check admin nineum: ${nineumResponse.status}`);
            return false;
        }

        const nineumData = await nineumResponse.json();
        const hasAdminNineum = nineumData && nineumData.count > 0;

        console.log(`✅ Admin check result: ${hasAdminNineum} (count: ${nineumData?.count || 0})`);
        return hasAdminNineum;

    } catch (error) {
        console.error('❌ Error checking admin status:', error);
        return false;
    }
}

/**
 * Resolve submitLinkitylinkTemplate spell
 * Allows users to submit custom templates and earn when they're used
 *
 * Cost: 600 MP
 *
 * Payload:
 * {
 *   paymentMethod: 'mp' | 'money',
 *   template: {
 *     name: 'Sunset Gradient',
 *     colors: ['#ff6b6b', '#ee5a6f', '#feca57'],
 *     linkColors: ['#10b981', '#3b82f6', '#8b5cf6', '#ec4899']
 *   },
 *   payeeQuadEmojicode: '🔗💎🌟🎨🐉📌🌍🔑'
 * }
 */
async function resolveSubmitTemplateSpell(caster, payload) {
    console.log('🎨 Resolving submitLinkitylinkTemplate spell...');

    const { paymentMethod, template, payeeQuadEmojicode } = payload;

    // Validate required components
    if (!template || !template.name || !template.colors || !template.linkColors) {
        return { success: false, error: 'Invalid template structure' };
    }

    if (!Array.isArray(template.colors) || template.colors.length === 0) {
        return { success: false, error: 'Template colors must be a non-empty array' };
    }

    if (!Array.isArray(template.linkColors) || template.linkColors.length === 0) {
        return { success: false, error: 'Template linkColors must be a non-empty array' };
    }

    if (!payeeQuadEmojicode || payeeQuadEmojicode.length !== 8) {
        return { success: false, error: 'Invalid payeeQuadEmojicode (must be 8 emojis)' };
    }

    if (!paymentMethod || (paymentMethod !== 'mp' && paymentMethod !== 'money')) {
        return { success: false, error: 'Invalid payment method (must be mp or money)' };
    }

    // Process payment (600 MP)
    const paymentResult = await processSpellPayment(caster, paymentMethod, 600); // 600 MP
    if (!paymentResult.success) {
        return paymentResult;
    }

    console.log(`✅ Payment processed (600 MP)`);

    // Build template BDO
    const templateBDO = {
        type: 'linkitylink-template',
        name: template.name,
        colors: template.colors,
        linkColors: template.linkColors,
        payeeEmojicode: payeeQuadEmojicode,
        creatorPubKey: caster.pubKey,
        submittedAt: new Date().toISOString(),
        status: 'pending' // Requires admin approval before showing to users
    };

    // Generate temporary keys for template BDO
    const saveKeys = (keys) => { tempKeys = keys; };
    const getKeys = () => tempKeys;
    let tempKeys = null;

    const keys = await sessionless.generateKeys(saveKeys, getKeys);
    const pubKey = keys.pubKey;

    console.log(`🔑 Generated template BDO keys: ${pubKey.substring(0, 16)}...`);

    // Create template BDO
    const hash = 'Linkitylink-Template';
    console.log(`🌐 Creating template BDO with hash: ${hash}`);

    const bdoUUID = await bdoLib.createUser(hash, templateBDO, saveKeys, getKeys);
    console.log(`✅ Template BDO created: ${bdoUUID}`);

    // Make BDO public to get emojicode
    console.log(`🌍 Making template BDO public...`);
    const updatedBDO = await bdoLib.updateBDO(bdoUUID, hash, templateBDO, true);
    const emojicode = updatedBDO.emojiShortcode;

    console.log(`✅ Template emojicode: ${emojicode}`);

    // Add template to BDO service index for querying
    try {
        const addToIndexURL = `${BDO_BASE_URL}/templates/${hash}/add`;
        const indexResponse = await fetch(addToIndexURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emojicode })
        });

        if (indexResponse.ok) {
            console.log(`✅ Added template ${emojicode} to BDO index`);
        } else {
            console.warn(`⚠️ Failed to add template to index: ${indexResponse.status}`);
        }
    } catch (err) {
        console.warn(`⚠️ Failed to add template to index:`, err.message);
    }

    // Save to creator's carrierBag
    const carrierBagResult = await saveToCarrierBag(caster.pubKey, 'linkitylinkTemplates', {
        title: template.name,
        type: 'linkitylink-template',
        emojicode: emojicode,
        bdoPubKey: pubKey,
        payeeQuadEmojicode: payeeQuadEmojicode,
        createdAt: templateBDO.submittedAt
    });

    if (!carrierBagResult.success) {
        console.warn('⚠️ Failed to save template to carrierBag, but spell succeeded');
    }

    // Return success
    return {
        success: true,
        uuid: bdoUUID,
        pubKey: pubKey,
        emojicode: emojicode,
        templateName: template.name,
        payment: paymentResult.payment,
        message: 'Template submitted successfully! You will earn a share when users purchase linkitylinks with your template.'
    };
}

// Template cache with 5-minute TTL
let templateCache = {
    templates: [],
    lastFetched: null,
    ttl: 5 * 60 * 1000 // 5 minutes
};

/**
 * GET /templates - Get all user-submitted templates
 *
 * Fetches all linkitylink-template BDOs from the BDO service.
 * Returns active templates with their payee information for revenue sharing.
 * Caches results for 5 minutes to reduce BDO service load.
 */
app.get('/templates', async (req, res) => {
    try {
        console.log('🎨 Fetching user-submitted templates...');

        // Check cache
        const now = Date.now();
        if (templateCache.lastFetched && (now - templateCache.lastFetched) < templateCache.ttl) {
            console.log(`✅ Returning ${templateCache.templates.length} cached templates`);
            return res.json({
                success: true,
                templates: templateCache.templates,
                cached: true
            });
        }

        // Query BDO service for all templates with hash 'Linkitylink-Template'
        const hash = 'Linkitylink-Template';
        const templatesURL = `${BDO_BASE_URL}/templates/${hash}`;

        console.log(`📡 Querying BDO service: ${templatesURL}`);

        const response = await fetch(templatesURL);

        if (!response.ok) {
            throw new Error(`BDO service returned ${response.status}`);
        }

        const data = await response.json();

        console.log(`✅ Received ${data.count} templates from BDO service`);

        // Filter for approved templates only (pending/rejected templates are hidden)
        const templates = data.templates
            .filter(t => t.status === 'approved')
            .map(t => ({
                name: t.name,
                colors: t.colors,
                linkColors: t.linkColors,
                emojicode: t.emojicode,
                payeeEmojicode: t.payeeEmojicode,
                creatorPubKey: t.creatorPubKey
            }));

        // Update cache
        templateCache.templates = templates;
        templateCache.lastFetched = now;

        res.json({
            success: true,
            templates: templates,
            count: templates.length
        });

    } catch (error) {
        console.error('❌ Error fetching templates:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /templates/pending - Get pending templates for admin moderation
 *
 * Admin-only endpoint. Returns all templates with status 'pending' awaiting approval.
 */
app.get('/templates/pending', async (req, res) => {
    try {
        // Verify admin status
        const pubKey = req.query.pubKey;
        if (!pubKey) {
            return res.status(401).json({
                success: false,
                error: 'Missing pubKey parameter'
            });
        }

        const isAdmin = await checkIsAdmin(pubKey);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                error: 'Unauthorized - admin nineum required'
            });
        }

        console.log('🎨 Fetching pending templates for admin review...');

        // Query BDO service for all templates
        const hash = 'Linkitylink-Template';
        const templatesURL = `${BDO_BASE_URL}/templates/${hash}`;

        console.log(`📡 Querying BDO service: ${templatesURL}`);

        const response = await fetch(templatesURL);

        if (!response.ok) {
            throw new Error(`BDO service returned ${response.status}`);
        }

        const data = await response.json();

        console.log(`✅ Received ${data.count} total templates from BDO service`);

        // Filter for pending templates only
        const pendingTemplates = data.templates
            .filter(t => t.status === 'pending')
            .map(t => ({
                name: t.name,
                colors: t.colors,
                linkColors: t.linkColors,
                emojicode: t.emojicode,
                payeeEmojicode: t.payeeEmojicode,
                creatorPubKey: t.creatorPubKey,
                submittedAt: t.submittedAt
            }));

        console.log(`📋 Returning ${pendingTemplates.length} pending templates`);

        res.json({
            success: true,
            templates: pendingTemplates,
            count: pendingTemplates.length
        });

    } catch (error) {
        console.error('❌ Error fetching pending templates:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * PUT /template/:emojicode/moderate - Approve or reject a template
 *
 * Admin-only endpoint. Updates template status to 'approved' or 'rejected'.
 *
 * Body: { pubKey: string, action: 'approve' | 'reject' }
 */
app.put('/template/:emojicode/moderate', async (req, res) => {
    try {
        const { emojicode } = req.params;
        const { pubKey, action } = req.body;

        // Validate inputs
        if (!pubKey) {
            return res.status(400).json({
                success: false,
                error: 'Missing pubKey in request body'
            });
        }

        if (!action || !['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action - must be "approve" or "reject"'
            });
        }

        // Verify admin status
        const isAdmin = await checkIsAdmin(pubKey);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                error: 'Unauthorized - admin nineum required'
            });
        }

        console.log(`🎨 Moderating template ${emojicode}: ${action}`);

        // Fetch template BDO via emojicode
        const templateBDO = await bdoLib.getBDOByEmojicode(emojicode);

        if (!templateBDO || !templateBDO.bdo) {
            return res.status(404).json({
                success: false,
                error: 'Template not found'
            });
        }

        const bdo = templateBDO.bdo;

        // Verify it's a template
        if (bdo.type !== 'linkitylink-template') {
            return res.status(400).json({
                success: false,
                error: 'BDO is not a linkitylink template'
            });
        }

        // Update status
        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        bdo.status = newStatus;
        bdo.moderatedAt = new Date().toISOString();
        bdo.moderatedBy = pubKey;

        // Update the BDO
        const hash = 'Linkitylink-Template';
        await bdoLib.updateBDO(templateBDO.uuid, hash, bdo, true); // Keep it public

        console.log(`✅ Template ${emojicode} ${newStatus}`);

        // Clear cache so next request gets updated data
        templateCache.lastFetched = 0;

        res.json({
            success: true,
            emojicode: emojicode,
            status: newStatus,
            message: `Template ${action}d successfully`
        });

    } catch (error) {
        console.error('❌ Error moderating template:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================================
// App Handoff Endpoints - Web-to-App purchase flow
// ============================================================================

/**
 * POST /handoff/create - Create a pending handoff for app purchase
 *
 * Creates a BDO (unpurchased) and initiates handoff to The Advancement app.
 * Returns a token and auth sequence for the color game.
 *
 * Body: {
 *   title: "My Links",
 *   links: [...],
 *   relevantBDOs: { emojicodes: [...], pubKeys: [...] }
 * }
 */
app.post('/handoff/create', async (req, res) => {
    try {
        console.log('📱 Creating app handoff...');

        const { bdoData, relevantBDOs, productType } = req.body;

        // Extract links from bdoData or directly from body (backward compat)
        const links = bdoData?.links || req.body.links;
        const title = bdoData?.title || req.body.title;

        // Validate
        if (!links || !Array.isArray(links) || links.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid links array'
            });
        }

        // Generate SVG for the BDO
        const svgTemplate = chooseSVGTemplate(links.length);
        const svgContent = svgTemplate(links);

        // Build BDO data (not yet saved to BDO service)
        const finalBdoData = {
            title: title || 'My Links',
            type: 'linkitylink',
            svgContent: svgContent,
            links: links,
            source: bdoData?.source || 'create-page',
            style: bdoData?.style,
            template: bdoData?.template,
            createdAt: new Date().toISOString(),
            status: 'pending_purchase'
        };

        // Generate keys for the BDO (we'll need these for association later)
        let bdoKeys;
        const saveKeys = (keys) => { bdoKeys = keys; };
        const getKeys = () => bdoKeys;

        const keys = await sessionless.generateKeys(saveKeys, getKeys);
        const bdoPubKey = keys.pubKey;

        console.log(`🔑 Generated BDO keys: ${bdoPubKey.substring(0, 16)}...`);

        // Store the keys in session for later use
        req.session.pendingBdoKeys = bdoKeys;
        await new Promise((resolve, reject) => {
            req.session.save((err) => err ? reject(err) : resolve());
        });

        // Create pending handoff
        const handoff = createPendingHandoff({
            bdoData: finalBdoData,
            bdoPubKey,
            bdoEmojicode: null, // Not yet created
            relevantBDOs: relevantBDOs || { emojicodes: [], pubKeys: [] },
            productType: productType || 'linkitylink',
            webPrice: 2000,  // $20.00
            appPrice: 1500   // $15.00 (25% discount)
        });

        console.log(`✅ Handoff created: ${handoff.token.substring(0, 8)}...`);

        res.json({
            success: true,
            token: handoff.token,
            sequence: handoff.sequence,
            expiresAt: handoff.expiresAt,
            webPrice: 2000,
            appPrice: 1500,
            discount: 500,
            discountPercent: 25
        });

    } catch (error) {
        console.error('❌ Error creating handoff:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /handoff/:token/verify - Verify the auth sequence
 *
 * User has completed the color sequence game. Verify it.
 *
 * Body: { sequence: ['red', 'blue', 'green', 'yellow', 'purple'] }
 */
app.post('/handoff/:token/verify', async (req, res) => {
    try {
        const { token } = req.params;
        const { sequence } = req.body;

        console.log(`📱 Verifying handoff sequence: ${token.substring(0, 8)}...`);

        const result = verifyAuthSequence(token, sequence);

        if (result.success) {
            console.log(`✅ Sequence verified for: ${token.substring(0, 8)}...`);
        }

        res.json(result);

    } catch (error) {
        console.error('❌ Error verifying sequence:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /handoff/:token/associate - Associate app credentials with handoff
 *
 * Called by The Advancement app after auth sequence is completed.
 * Links the app's pubKey to this handoff.
 *
 * Body: { pubKey, uuid, timestamp, signature }
 */
app.post('/handoff/:token/associate', async (req, res) => {
    try {
        const { token } = req.params;
        const appCredentials = req.body;

        console.log(`📱 Associating app with handoff: ${token.substring(0, 8)}...`);

        const result = associateAppCredentials(token, appCredentials);

        if (result.success) {
            console.log(`✅ App associated: ${appCredentials.pubKey?.substring(0, 16)}...`);
        }

        res.json(result);

    } catch (error) {
        console.error('❌ Error associating app:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /handoff/:token/status - Get handoff status for polling
 *
 * Called by the web page to check if the app has completed the sequence.
 * Returns status flags for UI updates.
 */
app.get('/handoff/:token/status', async (req, res) => {
    try {
        const { token } = req.params;

        const handoff = getPendingHandoff(token);

        if (!handoff) {
            return res.status(404).json({
                success: false,
                error: 'Handoff not found or expired'
            });
        }

        res.json({
            success: true,
            sequenceCompleted: handoff.sequenceCompleted,
            appPubKey: handoff.appPubKey ? handoff.appPubKey.substring(0, 16) + '...' : null,
            completedAt: handoff.completedAt,
            emojicode: handoff.completedAt ? handoff.bdoEmojicode : null,
            bdoPubKey: handoff.completedAt ? handoff.bdoPubKey : null
        });

    } catch (error) {
        console.error('❌ Error getting handoff status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /handoff/:token - Get handoff data for the app
 *
 * Called by The Advancement app to get BDO data for display.
 * Requires appPubKey query param for verification.
 */
app.get('/handoff/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { appPubKey } = req.query;

        console.log(`📱 Getting handoff: ${token.substring(0, 8)}...`);

        const result = getHandoffForApp(token, appPubKey);

        res.json(result);

    } catch (error) {
        console.error('❌ Error getting handoff:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /handoff/:token/complete - Complete the handoff after purchase
 *
 * Called after successful payment in the app.
 * Creates the actual BDO and adds to carrierBag.
 *
 * Body: { appPubKey, paymentConfirmation }
 */
app.post('/handoff/:token/complete', async (req, res) => {
    try {
        const { token } = req.params;
        const { appPubKey } = req.body;

        console.log(`📱 Completing handoff: ${token.substring(0, 8)}...`);

        const handoff = getPendingHandoff(token);

        if (!handoff) {
            return res.status(404).json({
                success: false,
                error: 'Handoff not found or expired'
            });
        }

        if (handoff.appPubKey !== appPubKey) {
            return res.status(403).json({
                success: false,
                error: 'App not authorized for this handoff'
            });
        }

        // Now actually create the BDO
        console.log('🎨 Creating actual BDO...');

        // Get keys from session if available, or generate new ones
        let bdoKeys = req.session.pendingBdoKeys;
        if (!bdoKeys) {
            const saveKeys = (keys) => { bdoKeys = keys; };
            const getKeys = () => bdoKeys;
            await sessionless.generateKeys(saveKeys, getKeys);
        }

        const saveKeys = (keys) => { bdoKeys = keys; };
        const getKeys = () => bdoKeys;
        sessionless.getKeys = getKeys;

        // Create BDO in BDO service
        const hash = 'Linkitylink';
        const bdoUUID = await bdoLib.createUser(hash, handoff.bdoData, saveKeys, getKeys);
        console.log(`✅ BDO created: ${bdoUUID}`);

        // Make BDO public
        const updatedBDO = await bdoLib.updateBDO(bdoUUID, hash, handoff.bdoData, true);
        const emojicode = updatedBDO.emojiShortcode;
        console.log(`✅ Emojicode: ${emojicode}`);

        // Store pubKey metadata for alphanumeric URL lookup
        bdoMetadataMap.set(handoff.bdoPubKey, {
            uuid: bdoUUID,
            emojicode: emojicode,
            createdAt: new Date(),
            purchasedVia: 'app-handoff',
            appPubKey: appPubKey
        });
        markMappingsDirty();

        // Mark handoff as complete
        completeHandoff(token);

        // Clean up session
        delete req.session.pendingBdoKeys;
        req.session.save(() => {});

        res.json({
            success: true,
            uuid: bdoUUID,
            pubKey: handoff.bdoPubKey,
            emojicode: emojicode,
            message: 'BDO created and added to carrierBag'
        });

    } catch (error) {
        console.error('❌ Error completing handoff:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /handoff/stats - Get handoff statistics (debug)
 */
app.get('/handoff-stats', async (req, res) => {
    res.json(getHandoffStats());
});

// ============================================================================

// Start server
app.listen(PORT, () => {
    console.log(`\n✅ Linkitylink tapestry weaver active on port ${PORT}`);
    console.log(`🌐 View demo: http://localhost:${PORT}`);
    console.log(`\n📝 Viewing Modes:`);
    console.log(`   Demo tapestry: http://localhost:${PORT}`);
    console.log(`   By emojicode: http://localhost:${PORT}/view/😀🔗💎🌟...`);
    console.log(`   By alphanumeric: http://localhost:${PORT}/t/abc123...`);
    console.log(`   Legacy auth: http://localhost:${PORT}?pubKey=YOUR_PUBKEY&timestamp=TIMESTAMP&signature=SIGNATURE`);
    console.log(`\n📝 Creation Endpoints:`);
    console.log(`   POST /create - Create new Linkitylink with auto-generated SVG`);
    console.log(`   POST /magic/spell/linkitylink - Cast linkitylink spell (carrierBag links)`);
    console.log(`   POST /magic/spell/glyphtree - Cast glyphtree spell (Linktree URL)`);
    console.log(`\n📱 App Handoff Endpoints:`);
    console.log(`   POST /handoff/create - Start web-to-app handoff`);
    console.log(`   POST /handoff/:token/verify - Verify auth sequence`);
    console.log(`   POST /handoff/:token/associate - Associate app credentials`);
    console.log(`   GET  /handoff/:token - Get handoff data for app`);
    console.log(`   POST /handoff/:token/complete - Complete purchase`);
    console.log('');
});
