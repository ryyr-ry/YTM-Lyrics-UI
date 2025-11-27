/**
 * background.js
 * 
 * v5.7 - Robust Search & Scoring Logic
 * - Fixed a critical bug in `cleanText` that removed valid parts of song titles.
 * - Fixed a bug in `tryApiSearch` that generated an incorrect 'q' parameter.
 * - Made the scoring algorithm stricter regarding duration differences.
 */

const CONFIG = {
    apiSearchBase: "https://lrclib.net/api/search",
    apiGetBase: "https://lrclib.net/api/get",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    appName: "YTM-Modern-UI/1.0 (Unofficial Extension)",
    ttlRevalidate: 30 * 24 * 60 * 60 * 1000,
    ttlExpire: 365 * 24 * 60 * 60 * 1000,
    storageKeyPrefix: "lyric_"
};

const SCRIPT_REGEX = {
    'ja': /[\u3-…-\u9FFF]/, 
    'ko': /[\uAC00-\uD7AF]/, 'zh': /[\u4E00-\u9FFF]/, 'ru': /[\u0400-\u04FF]/,
};

// --- 初期化 & メッセージング ---
chrome.runtime.onStartup.addListener(() => { garbageCollectCache(); });
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchLyrics") {
        handleLyricsRequest(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => {
                console.error("[BG] Error:", err);
                sendResponse({ success: false, error: err.message });
            });
        return true; 
    }
});

// --- キャッシュロジック ---
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

// --- ユーティリティ & スコアリング ---

/**
 * API送信前のパラメータから不要な空白文字を除去する
 */
function sanitize(text) {
    if (!text) return "";
    return text.replace(/[\s　]+/g, ' ').trim();
}

/**
 * 曲名やアーティスト名から検索ノイズとなる補足情報を除去する
 */
function cleanText(text) {
    if (!text) return "";
    return text
        // カッコで囲まれた部分を削除 (e.g., " (Official Video)", " [Live]")
        .replace(/\s*[\(\[-\{\<].*?[\)\]-\}\>].*/, "") 
        // YouTube特有の定型句を削除
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

/**
 * 候補のスコアリング
 * 再生時間の大幅なズレに対するペナルティを強化
 */
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
        else if (diff > 10) return -1000; // 10秒以上ズレていたら即却下
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

// --- 歌詞取得ロジック ---
async function logResponse(response) {
    const clonedResponse = response.clone();
    const responseBody = await clonedResponse.text();
    console.log(`[BG] Response Status: ${clonedResponse.status}`);
    console.log('[BG] Response Headers:', Object.fromEntries(clonedResponse.headers.entries()));
    console.log('[BG] Response Body:', responseBody);
    return response;
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
        console.log(`[BG] Attempting GET /api/get with URL: ${url}`);
        let res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, 'Lrclib-Client': CONFIG.appName } });
        res = await logResponse(res);
        if (res.status === 200) {
            const data = await res.json();
            return parseLRC(data.syncedLyrics);
        }
        return null;
    } catch (e) {
        console.warn(`[BG] API GET request failed (album: ${includeAlbum}):`, e);
        return null;
    }
}

async function tryApiSearch(title, artist, album, lang, duration) {
    try {
        // 'q'パラメータ用に、スペースで連結した検索文字列を作成
        const query = `${title} ${artist}`.trim();
        const params = new URLSearchParams({ q: query });
        
        const url = `${CONFIG.apiSearchBase}?${params.toString()}`;
        console.log(`[BG] Attempting GET /api/search with URL: ${url}`);

        let res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, 'Lrclib-Client': CONFIG.appName } });
        res = await logResponse(res);
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

        // しきい値を70に引き上げ、より信頼性の高いマッチのみ採用
        if (bestMatch && bestMatch.score > 70) {
            return parseLRC(bestMatch.item.syncedLyrics);
        }
        return null;
    } catch (e) { 
        console.warn("[BG] API Search request failed:", e);
        return null;
    }
}

async function fetchLyricsHandler(title, artist, album, lang, duration) {
    // APIに渡す前にパラメータをサニタイズ
    const sTitle = sanitize(title);
    const sArtist = sanitize(artist);
    const sAlbum = sanitize(album);
    let lyrics;

    lyrics = await tryApiGet(sTitle, sArtist, sAlbum, duration, true);
    if (lyrics) return lyrics;

    lyrics = await tryApiGet(sTitle, sArtist, sAlbum, duration, false);
    if (lyrics) return lyrics;
    
    lyrics = await tryApiSearch(sTitle, sArtist, sAlbum, lang, duration);
    if (lyrics) return lyrics;

    // 最終手段: cleanTextでさらに加工して再検索
    const cTitle = cleanText(title);
    const cArtist = cleanText(artist);
    if (cTitle !== title || cArtist !== artist) {
        lyrics = await tryApiSearch(cTitle, cArtist, sAlbum, lang, duration);
        if (lyrics) return lyrics;
    }

    return lyrics || [{ time: 0, text: "Lyrics not found" }];
}