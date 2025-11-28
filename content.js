/**
 * content.js
 *
 * v6.0 - Multi-Tab State Broadcasting
 * 
 * Overview:
 * Implements a "Push" architecture for the popup UI.
 * Instead of waiting for the popup to request data, this script proactively
 * broadcasts the current player state (metadata, playback status) to the
 * background script whenever a change is detected.
 * 
 * Key Changes:
 * - Added `broadcastCurrentState()` to send data to background.
 * - Added event listeners for video 'play', 'pause', and 'timeupdate'.
 * - Preserved existing lyrics rendering and immersive UI logic.
 */
'use strict';

(function() {
    // --- 1. Configuration & State Management ---
    const CONFIG = {
        scrollBehavior: "smooth",
        activeClass: "active",
        layoutClass: "ytm-custom-layout",
        desktopBarClass: "ytm-is-desktop-bar",
        mobileBarClass: "ytm-is-mobile-bar",
        
        watchInterval: 500,       // Interval for UI checks
        artworkRetryInterval: 200,
        artworkMaxRetries: 15,
        durationMaxRetries: 20,
        
        // Throttling for broadcast to prevent flooding the background script
        broadcastThrottle: 1000   
    };

    const DOM = {
        pageObserver: null, songObserver: null, appLayout: null,
        playerBar: null, bg: null, wrapper: null, title: null,
        artist: null, artwork: null, lyrics: null,
    };

    let state = {
        // Core features
        isEnabled: true,
        isContextInvalidated: false,
        currentSongId: null,
        fetchRequestId: 0,
        
        // Lyrics data
        lyrics: [],
        lyricLines: [],
        
        // Broadcasting control
        lastBroadcastTime: 0,
        lastBroadcastHash: "" // To prevent sending duplicate states
    };

    // --- 2. UI Construction (Existing Logic) ---
    function createUI() {
        if (document.getElementById('ytm-custom-wrapper')) return;
        DOM.bg = document.createElement('div'); DOM.bg.id = 'ytm-custom-bg';
        DOM.wrapper = document.createElement('div'); DOM.wrapper.id = 'ytm-custom-wrapper';
        const leftCol = document.createElement('div'); leftCol.id = 'ytm-custom-left-col';
        DOM.artwork = document.createElement('div'); DOM.artwork.id = 'ytm-artwork-container';
        const infoArea = document.createElement('div'); infoArea.id = 'ytm-custom-info-area';
        DOM.title = document.createElement('div'); DOM.title.id = 'ytm-custom-title';
        DOM.artist = document.createElement('div'); DOM.artist.id = 'ytm-custom-artist';
        infoArea.append(DOM.title, DOM.artist); leftCol.append(DOM.artwork, infoArea);
        DOM.lyrics = document.createElement('div'); DOM.lyrics.id = 'my-lyrics-container';
        DOM.wrapper.append(leftCol, DOM.lyrics);
        document.body.append(DOM.bg, DOM.wrapper);
    }

    function updateLayout() {
        const layout = document.querySelector('ytmusic-app-layout');
        const isPlayerOpen = layout && layout.hasAttribute('player-page-open');
        const shouldShow = state.isEnabled && isPlayerOpen && !state.isContextInvalidated;
        document.body.classList.toggle(CONFIG.layoutClass, shouldShow);
    }
    
    function renderLyrics(data) {
        if (!DOM.lyrics) return;
        DOM.lyrics.innerHTML = '';
        state.lyricLines = [];
        const frag = document.createDocumentFragment();
        data.forEach((line) => {
            const p = document.createElement('div');
            p.className = 'lyric-line';
            p.textContent = line.text;
            p.onclick = () => {
                const video = document.querySelector('video');
                if (video) video.currentTime = line.time;
            };
            frag.appendChild(p);
        });
        DOM.lyrics.appendChild(frag);
        state.lyricLines = Array.from(DOM.lyrics.children);
    }

    function showErrorState(msg) {
        if (!DOM.lyrics) return;
        DOM.lyrics.innerHTML = `<div class="lyric-line" style="color:#ff5555; opacity:1;">${msg}</div>`;
    }
    
    async function getVerifiedArtwork(targetTitle) {
        const normalize = (str) => str ? str.toLowerCase().replace(/\s+/g, '') : "";
        const normTarget = normalize(targetTitle);
        
        // Try getting artwork from MediaSession (High Resolution)
        for (let i = 0; i < CONFIG.artworkMaxRetries; i++) {
            if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
                const meta = navigator.mediaSession.metadata;
                const normMetaTitle = normalize(meta.title);
                if (normMetaTitle.includes(normTarget) || normTarget.includes(normMetaTitle)) {
                    if (meta.artwork && meta.artwork.length > 0) {
                        return meta.artwork[meta.artwork.length - 1].src;
                    }
                }
            }
            await new Promise(r => setTimeout(r, CONFIG.artworkRetryInterval));
        }
        // Fallback to DOM image
        const fallbackImg = document.querySelector('.thumbnail-image-wrapper img');
        return fallbackImg ? fallbackImg.src : null;
    }

    // --- 3. State Broadcasting (New Feature) ---

    /**
     * Scrapes the current player state from DOM and MediaSession.
     * Returns a normalized object ready for broadcasting.
     */
    function capturePlayerState() {
        const titleEl = document.querySelector('yt-formatted-string.title.style-scope.ytmusic-player-bar');
        const subtitleEl = document.querySelector('.byline.style-scope.ytmusic-player-bar');
        const video = document.querySelector('video');
        const artworkEl = document.querySelector('ytmusic-player-bar .thumbnail-image-wrapper img');

        // Basic validation
        if (!titleEl || !subtitleEl) return null;

        const title = titleEl.textContent;
        const bylineText = subtitleEl.textContent;
        const artist = bylineText.split('•')[0].trim();
        const album = (navigator.mediaSession.metadata && navigator.mediaSession.metadata.album) || "";
        
        // Determine playback status
        // If video exists and is not paused, we consider it playing.
        const isPlaying = video ? !video.paused : false;
        const currentTime = video ? video.currentTime : 0;
        const duration = video ? video.duration : 0;

        // Artwork: Prefer MediaSession, fallback to DOM
        let artworkUrl = artworkEl ? artworkEl.src : null;
        if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
            const meta = navigator.mediaSession.metadata;
            if (meta.artwork && meta.artwork.length > 0) {
                artworkUrl = meta.artwork[meta.artwork.length - 1].src;
            }
        }

        return {
            title,
            artist,
            album,
            artwork: artworkUrl,
            status: isPlaying ? 'playing' : 'paused',
            currentTime,
            duration,
            timestamp: Date.now()
        };
    }

    /**
     * Sends the current state to the background script.
     * Includes debouncing/deduplication logic to minimize overhead.
     * @param {boolean} force - If true, ignores deduplication and sends immediately.
     */
    function broadcastCurrentState(force = false) {
        if (state.isContextInvalidated) return;

        const playerData = capturePlayerState();
        if (!playerData) return;

        // Create a simple hash to check if data actually changed
        // We exclude 'currentTime' and 'timestamp' from hash to avoid spamming every second
        const dataHash = JSON.stringify({
            t: playerData.title,
            a: playerData.artist,
            s: playerData.status,
            art: playerData.artwork
        });

        const now = Date.now();
        const shouldSend = force || 
                           (dataHash !== state.lastBroadcastHash) || 
                           (now - state.lastBroadcastTime > CONFIG.broadcastThrottle);

        if (shouldSend) {
            state.lastBroadcastHash = dataHash;
            state.lastBroadcastTime = now;

            try {
                chrome.runtime.sendMessage({
                    action: 'updateState',
                    data: playerData
                });
            } catch (e) {
                // Extension context invalidated (e.g., update or disabled)
                console.warn("[YTM Modern UI] Context invalidated during broadcast:", e);
                state.isContextInvalidated = true;
            }
        }
    }

    // --- 4. Core Logic (Existing & Extended) ---
    
    function handleTimeUpdate() {
        // Existing lyrics scrolling logic
        if (state.lyrics.length && document.body.classList.contains(CONFIG.layoutClass)) {
            const video = document.querySelector('video');
            if (video) {
                let activeIndex = -1;
                for (let i = 0; i < state.lyrics.length; i++) {
                    if (video.currentTime >= state.lyrics[i].time) activeIndex = i;
                    else break;
                }
                if (activeIndex !== -1 && state.lyricLines[activeIndex]) {
                    const activeLine = state.lyricLines[activeIndex];
                    if (!activeLine.classList.contains(CONFIG.activeClass)) {
                        state.lyricLines.forEach(l => l.classList.remove(CONFIG.activeClass));
                        activeLine.classList.add(CONFIG.activeClass);
                        const isMobile = window.innerWidth <= 950;
                        activeLine.scrollIntoView({ behavior: activeIndex === 0 ? "auto" : CONFIG.scrollBehavior, block: "center", inline: isMobile ? "center" : "nearest" });
                    }
                }
            }
        }
    }

    async function onSongChanged() {
        if (state.isContextInvalidated) return;
        
        // 1. Capture basic info
        const titleEl = document.querySelector('yt-formatted-string.title.style-scope.ytmusic-player-bar');
        const subtitleEl = document.querySelector('.byline.style-scope.ytmusic-player-bar');
        if (!titleEl || !subtitleEl) return;
        
        const title = titleEl.textContent;
        const bylineText = subtitleEl.textContent;
        const bylineParts = bylineText.split('•').map(s => s.trim());
        const artist = bylineParts[0] || "";
        const album = (navigator.mediaSession.metadata && navigator.mediaSession.metadata.album) || (bylineParts.length > 1 ? bylineParts[1] : "");

        const songId = `${title}|||${artist}`;
        
        // 2. Broadcast immediately when song changes (Force update)
        broadcastCurrentState(true);

        if (state.currentSongId === songId) return;

        // 3. Update internal state for Lyrics fetching
        state.currentSongId = songId;
        state.fetchRequestId++; 
        const currentRequestId = state.fetchRequestId;
        
        if(DOM.title) DOM.title.textContent = title;
        if(DOM.artist) DOM.artist.textContent = artist;
        if(DOM.lyrics) DOM.lyrics.innerHTML = '<div class="lyric-line">Loading...</div>';
        
        // Update Artwork
        getVerifiedArtwork(title).then(url => {
            if (url && state.currentSongId === songId) {
                if (DOM.artwork) DOM.artwork.innerHTML = `<img src="${url}" crossorigin="anonymous">`;
                if (DOM.bg) DOM.bg.style.backgroundImage = `url(${url})`;
                // Re-broadcast after artwork is settled
                broadcastCurrentState(true);
            }
        });
        
        // Wait for duration
        let duration = 0;
        for (let i = 0; i < CONFIG.durationMaxRetries; i++) {
            const video = document.querySelector('video');
            if (video && video.duration && isFinite(video.duration)) {
                duration = video.duration;
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }

        if (state.fetchRequestId !== currentRequestId) return;
        
        // 4. Fetch Lyrics
        try {
            chrome.runtime.sendMessage({ 
                action: "fetchLyrics", 
                title, artist, album,
                lang: navigator.language, 
                duration
            }, (response) => {
                if (chrome.runtime.lastError) { 
                    state.isContextInvalidated = true; 
                    showErrorState("Extension invalidated. Please reload."); 
                    return; 
                }
                if (state.fetchRequestId !== currentRequestId) return;
                
                if (response && response.success && response.data.length > 0) {
                    state.lyrics = response.data;
                    renderLyrics(response.data);
                } else {
                    state.lyrics = [];
                    renderLyrics([{time: 0, text: "Lyrics not found"}]);
                }
            });
        } catch (e) {
            state.isContextInvalidated = true;
            showErrorState("Please reload the page");
        }
    }

    // --- 5. Observers & Initialization ---

    function attachObservers() {
        const appLayout = document.querySelector('ytmusic-app-layout');
        if (appLayout && appLayout !== DOM.appLayout) {
            if (DOM.pageObserver) DOM.pageObserver.disconnect();
            DOM.appLayout = appLayout;
            DOM.pageObserver = new MutationObserver(updateLayout);
            DOM.pageObserver.observe(appLayout, { attributes: true, attributeFilter: ['player-page-open'] });
        }
        const playerBar = document.querySelector('ytmusic-player-bar');
        if (playerBar && playerBar !== DOM.playerBar) {
            if (DOM.songObserver) DOM.songObserver.disconnect();
            DOM.playerBar = playerBar;
            // Observe DOM changes for Song info
            DOM.songObserver = new MutationObserver(onSongChanged);
            DOM.songObserver.observe(playerBar, { subtree: true, characterData: true, childList: true });
            onSongChanged();
        }
    }

    function attachVideoListeners() {
        const video = document.querySelector('video');
        if (video && !video.dataset.hasEnhancedListeners) {
            // Mark as attached
            video.dataset.hasEnhancedListeners = "true";

            // 1. Play/Pause: Broadcast state immediately
            video.addEventListener('play', () => broadcastCurrentState(true));
            video.addEventListener('pause', () => broadcastCurrentState(true));
            
            // 2. TimeUpdate: Used for Lyrics scrolling AND periodic state broadcast
            // We throttle broadcasting inside the function itself, so calling it here is safe.
            video.addEventListener('timeupdate', () => {
                requestAnimationFrame(handleTimeUpdate);
                // Broadcast occasionally during playback to keep time/status sync
                broadcastCurrentState(false); 
            });
        }
    }

    function detectAndApplyBarMode() {
        const mwebControls = document.querySelector('#right-controls-mweb');
        const isMobileMode = mwebControls && getComputedStyle(mwebControls).display !== 'none';
        const newMode = isMobileMode ? 'mobile' : 'desktop';
        if (newMode !== state.currentBarMode) {
            state.currentBarMode = newMode;
            document.body.classList.toggle(CONFIG.mobileBarClass, isMobileMode);
            document.body.classList.toggle(CONFIG.desktopBarClass, !isMobileMode);
        }
    }

    function init() {
        createUI();
        attachObservers();
        
        // Initial broadcast to register this tab in Background
        setTimeout(() => broadcastCurrentState(true), 1000);

        setInterval(() => {
            if (state.isContextInvalidated) return;
            detectAndApplyBarMode();
            
            // Check if DOM elements were re-created (SPA navigation)
            const currentLayout = document.querySelector('ytmusic-app-layout');
            const currentPlayer = document.querySelector('ytmusic-player-bar');
            if (currentLayout !== DOM.appLayout || currentPlayer !== DOM.playerBar) {
                attachObservers();
            }
            
            // Ensure video listeners are attached
            attachVideoListeners();
            
            updateLayout();
        }, CONFIG.watchInterval);
        
        // --- Message Listener ---
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'toggleMode') {
                state.isEnabled = request.isEnabled;
                updateLayout();
            } 
            // Legacy/Fallback: Pull request support (Keep for safety during migration)
            else if (request.action === 'getSongInfo') {
                const data = capturePlayerState();
                sendResponse(data);
            }
            // Force Sync Request from Popup (Re-hydration)
            else if (request.action === 'forceSync') {
                broadcastCurrentState(true);
                sendResponse({ received: true });
            }
        });

        chrome.storage.local.get(['isEnabled'], (result) => {
            state.isEnabled = result.isEnabled !== false;
            updateLayout();
        });

        chrome.storage.onChanged.addListener((changes) => {
            if (changes.isEnabled) {
                state.isEnabled = changes.isEnabled.newValue;
                updateLayout();
            }
        });
    }

    init();
})();