/**
 * background.js
 * 
 * v6.0 - Centralized State Store
 * 
 * Overview:
 * Acts as the "Source of Truth" for all YouTube Music tabs.
 * Maintains a real-time store of player states using `chrome.storage.session`
 * to survive Service Worker idle terminations.
 * 
 * Key Features:
 * - State Store: Maps tabId -> PlayerState.
 * - Life-cycle Management: Automatically cleans up closed/navigated tabs.
 * - Reactive Updates: Notifies connected popups immediately upon state changes.
 * - Lyrics Fetching: Parallel execution strategy (Preserved from v5.8).
 */

const CONFIG = {
    // API Endpoints
    apiSearchBase: "https://lrclib.net/api/search",
    apiGetBase: "https://lrclib.net/api/get",
    
    // Request Headers
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    appName: "YTM-Modern-UI/1.0 (Unofficial Extension)",
    
    // Cache Settings
    ttlRevalidate: 30 * 24 * 60 * 60 * 1000,
    ttlExpire: 365 * 24 * 60 * 60 * 1000,
    storageKeyPrefix: "lyric_",
    
    // Session Store Keys
    STORE_KEY: "activePlayers"
};

const SCRIPT_REGEX = {
    'ja': /[\u3-…-\u9FFF]/, 
    'ko': /[\uAC00-\uD7AF]/, 'zh': /[\u4E00-\u9FFF]/, 'ru': /[\u0400-\u04FF]/,
};

// --- 1. State Store Management (New) ---

/**
 * Updates the state for a specific tab in the session storage.
 * @param {number} tabId 
 * @param {object} playerData 
 */
async function updatePlayerState(tabId, playerData) {
    try {
        const store = await getSessionStore();
        store[tabId] = {
            ...playerData,
            lastUpdated: Date.now(),
            tabId: tabId // Ensure tabId is included in the object
        };
        await chrome.storage.session.set({ [CONFIG.STORE_KEY]: store });
        
        // Notify any open popups about the change
        chrome.runtime.sendMessage({ action: 'storeUpdated', store: store }).catch(() => {
            // No listeners (Popup closed) -> Ignore error
        });
    } catch (e) {
        console.warn("[BG] Update State Failed:", e);
    }
}

/**
 * Removes a tab from the store (e.g., tab closed).
 * @param {number} tabId 
 */
async function removePlayerState(tabId) {
    try {
        const store = await getSessionStore();
        if (store[tabId]) {
            delete store[tabId];
            await chrome.storage.session.set({ [CONFIG.STORE_KEY]: store });
            
            // Notify popup to remove this card
            chrome.runtime.sendMessage({ action: 'storeUpdated', store: store }).catch(() => {});
        }
    } catch (e) {
        console.warn("[BG] Remove State Failed:", e);
    }
}

/**
 * Helper to retrieve the current store object.
 * @returns {Promise<object>}
 */
async function getSessionStore() {
    const result = await chrome.storage.session.get(CONFIG.STORE_KEY);
    return result[CONFIG.STORE_KEY] || {};
}

/**
 * Validates the store against actual open tabs to remove "zombie" entries.
 * Useful when Service Worker wakes up or Popup opens.
 */
async function cleanUpZombies() {
    const store = await getSessionStore();
    const storedTabIds = Object.keys(store).map(Number);
    
    if (storedTabIds.length === 0) return;

    // Get all actual YTM tabs
    const tabs = await chrome.tabs.query({ url: "*://music.youtube.com/*" });
    const actualTabIds = new Set(tabs.map(t => t.id));

    let changed = false;
    for (const id of storedTabIds) {
        if (!actualTabIds.has(id)) {
            delete store[id];
            changed = true;
        }
    }

    if (changed) {
        await chrome.storage.session.set({ [CONFIG.STORE_KEY]: store });
    }
}

// --- 2. Event Listeners (Life-cycle) ---

chrome.runtime.onStartup.addListener(() => {
    garbageCollectCache();
    // Clear session store on browser startup
    chrome.storage.session.remove(CONFIG.STORE_KEY);
});

// Tab Closed -> Remove from store
chrome.tabs.onRemoved.addListener((tabId) => {
    removePlayerState(tabId);
});

// Tab Navigated/Updated -> Check if it's still YTM, otherwise remove
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        if (!tab.url || !tab.url.includes('music.youtube.com')) {
            removePlayerState(tabId);
        }
    }
});

// Message Handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // A. Content Script reporting state
    if (request.action === "updateState") {
        if (sender.tab && sender.tab.id) {
            updatePlayerState(sender.tab.id, request.data);
        }
    }
    
    // B. Popup requesting initial data
    else if (request.action === "getStoreSnapshot") {
        (async () => {
            await cleanUpZombies(); // Ensure fresh data
            const store = await getSessionStore();
            sendResponse(store);
        })();
        return true; // Async response
    }
    
    // C. Popup requesting force sync (Re-hydration)
    else if (request.action === "broadcastForceSync") {
        (async () => {
            const tabs = await chrome.tabs.query({ url: "*://music.youtube.com/*" });
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: "forceSync" }).catch(() => {});
            });
            sendResponse({ status: "broadcasted" });
        })();
        return true;
    }

    // D. Lyrics Fetching (Existing)
    else if (request.action === "fetchLyrics") {
        handleLyricsRequest(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => {
                console.error("[BG] Lyrics Error:", err);
                sendResponse({ success: false, error: err.message });
            });
        return true; 
    }
});

// --- 3. Lyrics Logic (Preserved from v5.8) ---

function getCacheKey(title, artist) { return CONFIG.storageKeyPrefix + normalize(title) + "_" + normalize(artist); }
async function garbageCollectCache() { try { const allData = await chrome.storage.local.get(null); const now = Date.now(); const keysToRemove = []; for (const [key, value] of Object.entries(allData)) { if (key.startsWith(CONFIG.storageKeyPrefix)) { const lastTime = value.lastAccessed || value.createdAt || now; if (now - lastTime > CONFIG.ttlExpire) keysToRemove.push(key); } } if (keysToRemove.length > 0) await chrome.storage.local.remove(keysToRemove); } catch (e) { console.warn("[Cache] GC failed:", e); } }
async function handleLyricsRequest({ title, artist, album, lang, duration }) {
    const key = getCacheKey(title, artist);
    const now = Date.now();
    let cached = null;
    try {
        const storageData = await chrome.storage.local.get(key);
        cached = storageData[key];
    } catch (e) { console.warn("[Cache] Read failed:", e); }

    if (cached) {
        cached.lastAccessed = now;
        chrome.storage.local.set({ [key]: cached });
        const age = now - (cached.updatedAt || 0);
        if (age > CONFIG.ttlRevalidate) {
            fetchAndCache(title, artist, album, lang, duration).catch(() => {});
        }
        return cached.lyrics;
    }
    return await fetchAndCache(title, artist, album, lang, duration);
}
async function fetchAndCache(title, artist, album, lang, duration) {
    const lyrics = await fetchLyricsHandler(title, artist, album, lang, duration);
    if (lyrics && lyrics.length > 1) {
        const key = getCacheKey(title, artist);
        const cacheEntry = {
            lyrics: lyrics, createdAt: Date.now(), updatedAt: Date.now(),
            lastAccessed: Date.now(), meta: { title, artist, album, duration }
        };
        try {
            await chrome.storage.local.set({ [key]: cacheEntry });
        } catch (e) { console.warn("[Cache] Write failed:", e); }
    }
    return lyrics;
}

function sanitize(text) {
    if (!text) return "";
    return text.replace(/[\s　]+/g, ' ').trim();
}

function cleanText(text) {
    if (!text) return "";
    return text
        .replace(/\s*[\(\[-\{\<].*?[\)\]-\}\>].*/, "") 
        .replace(/official\s+video|music\s+video|official\s+audio|lyric\s+video|hq|mv|pv/gi, "")
        .trim();
}

function parseLRC(lrcString) {
    if (!lrcString) return null;
    const lines = lrcString.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
    for (const line of lines) {
        const match = line.match(timeRegex);
        if (match) {
            const text = line.replace(timeRegex, '').trim();
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            const ms = parseFloat("0." + match[3]);
            if (text) {
                result.push({ time: min * 60 + sec + ms, text: text });
            }
        }
    }
    return result;
}

function normalize(str) {
    return str ? str.toLowerCase().replace(/[^a-z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, "") : "";
}

function checkArtistMatch(artistA, artistB) {
    const normA = normalize(artistA);
    const normB = normalize(artistB);
    if (normA === normB) return 100;
    if (normA.includes(normB) || normB.includes(normA)) return 80;
    return 0;
}

function calculateScore(item, qTitle, qArtist, userLang, targetDuration) {
    let score = 0;
    const iTitle = normalize(item.trackName);
    const qT = normalize(qTitle);
    const artistMatchScore = checkArtistMatch(item.artistName, qArtist);
    if (artistMatchScore === 0) return -9999;
    
    score += artistMatchScore;
    
    if (targetDuration > 0 && item.duration) {
        const diff = Math.abs(item.duration - targetDuration);
        if (diff <= 2) score += 50;
        else if (diff <= 5) score += 20;
        else if (diff > 10) return -1000;
        else score -= 50; 
    }
    
    if (iTitle === qT) score += 40;
    else if (iTitle.includes(qT) || qT.includes(iTitle)) score += 20;
    
    const lyricsSample = item.syncedLyrics || "";
    const targetRegex = SCRIPT_REGEX[userLang];
    if (targetRegex && targetRegex.test(lyricsSample)) {
        score += 100;
    }
    
    if (item.instrumental) score -= 100;
    
    return score;
}

async function tryApiGet(track_name, artist_name, album_name, duration, includeAlbum) {
    if (!track_name || !artist_name || !duration) return null;
    try {
        const params = new URLSearchParams({
            track_name,
            artist_name,
            duration: Math.round(duration)
        });
        if (includeAlbum && album_name) {
            params.append('album_name', album_name);
        }
        const url = `${CONFIG.apiGetBase}?${params.toString()}`;
        let res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, 'Lrclib-Client': CONFIG.appName } });
        if (res.status === 200) {
            const data = await res.json();
            return parseLRC(data.syncedLyrics);
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function tryApiSearch(title, artist, album, lang, duration) {
    try {
        const query = `${title} ${artist}`.trim();
        const params = new URLSearchParams({ q: query });
        const url = `${CONFIG.apiSearchBase}?${params.toString()}`;
        
        let res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, 'Lrclib-Client': CONFIG.appName } });
        if (!res.ok) throw new Error(`Status: ${res.status}`);

        const data = await res.json();
        const candidates = data.filter(item => item.syncedLyrics);
        if (candidates.length === 0) return null;

        const shortLang = (lang || "").split('-')[0];
        const scoredCandidates = candidates.map(item => ({
            item: item,
            score: calculateScore(item, title, artist, shortLang, duration)
        }));
        
        scoredCandidates.sort((a, b) => b.score - a.score);
        const bestMatch = scoredCandidates[0];

        if (bestMatch && bestMatch.score > 70) {
            return parseLRC(bestMatch.item.syncedLyrics);
        }
        return null;
    } catch (e) { 
        return null;
    }
}

async function fetchLyricsHandler(title, artist, album, lang, duration) {
    const sTitle = sanitize(title);
    const sArtist = sanitize(artist);
    const sAlbum = sanitize(album);

    const tasks = [
        { fn: () => tryApiGet(sTitle, sArtist, sAlbum, duration, true), name: "GET_WITH_ALBUM" },
        { fn: () => tryApiGet(sTitle, sArtist, sAlbum, duration, false), name: "GET_NO_ALBUM" },
        { fn: () => tryApiSearch(sTitle, sArtist, sAlbum, lang, duration), name: "SEARCH_RAW" }
    ];

    const cTitle = cleanText(title);
    const cArtist = cleanText(artist);
    if (cTitle !== title || cArtist !== artist) {
        tasks.push({
            fn: () => tryApiSearch(cTitle, cArtist, sAlbum, lang, duration),
            name: "SEARCH_CLEAN"
        });
    }

    const promises = tasks.map(t => t.fn());
    const results = await Promise.allSettled(promises);

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
            return result.value;
        }
    }

    return [{ time: 0, text: "Lyrics not found" }];
}