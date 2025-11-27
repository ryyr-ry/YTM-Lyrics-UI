/**
 * background.js
 * 
 * v5.8 - Parallel Execution
 * - Refactored fetchLyricsHandler to execute API requests in parallel.
 * - Prioritized results: GET(Album) > GET(NoAlbum) > Search(Raw) > Search(Clean).
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

// --- 歌詞取得ロジック (通信部) ---
async function logResponse(response, label) {
    // デバッグが必要な場合はコメントアウトを解除
    // const cloned = response.clone();
    // console.log(`[BG][${label}] Status: ${cloned.status}`);
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
        let res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, 'Lrclib-Client': CONFIG.appName } });
        // res = await logResponse(res, `GET:Album=${includeAlbum}`);
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
        const query = `${title} ${artist}`.trim();
        const params = new URLSearchParams({ q: query });
        const url = `${CONFIG.apiSearchBase}?${params.toString()}`;
        
        let res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent, 'Lrclib-Client': CONFIG.appName } });
        // res = await logResponse(res, "SEARCH");
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
        console.warn("[BG] API Search request failed:", e);
        return null;
    }
}

/**
 * 歌詞取得のメインハンドラ (並列処理版)
 */
async function fetchLyricsHandler(title, artist, album, lang, duration) {
    const sTitle = sanitize(title);
    const sArtist = sanitize(artist);
    const sAlbum = sanitize(album);

    // 実行するタスクリストを優先度順に作成
    const tasks = [
        // Priority 1: アルバム名込みの厳密なGET (最も精度が高い)
        { 
            fn: () => tryApiGet(sTitle, sArtist, sAlbum, duration, true),
            name: "GET_WITH_ALBUM" 
        },
        // Priority 2: アルバム名なしの厳密なGET (曲・アーティストは合っている)
        { 
            fn: () => tryApiGet(sTitle, sArtist, sAlbum, duration, false),
            name: "GET_NO_ALBUM"
        },
        // Priority 3: 標準メタデータでの検索 (表記ゆれに対応)
        { 
            fn: () => tryApiSearch(sTitle, sArtist, sAlbum, lang, duration),
            name: "SEARCH_RAW"
        }
    ];

    // Priority 4: クリーンアップ後のテキストでの検索 (ノイズ除去)
    // 元のタイトル/アーティストと変わる場合のみ追加
    const cTitle = cleanText(title);
    const cArtist = cleanText(artist);
    if (cTitle !== title || cArtist !== artist) {
        tasks.push({
            fn: () => tryApiSearch(cTitle, cArtist, sAlbum, lang, duration),
            name: "SEARCH_CLEAN"
        });
    }

    // 全タスクを並列実行
    // Promise.allSettled は全てのPromiseが完了(成功or失敗)するまで待つ
    // これにより、最も遅いリクエストに時間は合わせられるが、各リクエストは同時に走る
    const promises = tasks.map(t => t.fn());
    const results = await Promise.allSettled(promises);

    // 結果を「優先度順」に走査して、最初に成功(null以外)したものを採用する
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
            // console.log(`[BG] Selected Strategy: ${tasks[i].name}`); // デバッグ用
            return result.value;
        }
    }

    return [{ time: 0, text: "Lyrics not found" }];
}