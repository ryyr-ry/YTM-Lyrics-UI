/**
 * content.js
 *
 * v5.1 - Robust Duration Acquisition
 * - Implemented a retry loop in onSongChanged to ensure video.duration is
 *   available before sending a request, fixing issues on direct URL access.
 */
'use strict';

(function() {
    // --- 1. 設定 & 状態管理 ---
    const CONFIG = {
        scrollBehavior: "smooth",
        activeClass: "active",
        layoutClass: "ytm-custom-layout",
        desktopBarClass: "ytm-is-desktop-bar",
        mobileBarClass: "ytm-is-mobile-bar",
        watchInterval: 100,
        artworkRetryInterval: 200,
        artworkMaxRetries: 15,
        durationSettleTime: 150, // 最初の待機時間
        durationMaxRetries: 20     // duration取得の最大試行回数 (20 * 100ms = 2秒)
    };

    const DOM = {
        pageObserver: null, songObserver: null, appLayout: null,
        playerBar: null, bg: null, wrapper: null, title: null,
        artist: null, artwork: null, lyrics: null,
    };

    let state = {
        isEnabled: true, currentSongId: null, fetchRequestId: 0, lyrics: [],
        lyricLines: [], isContextInvalidated: false, currentBarMode: null
    };

    // --- 2. UI構築・制御 ---
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
        const fallbackImg = document.querySelector('.thumbnail-image-wrapper img');
        return fallbackImg ? fallbackImg.src : null;
    }
    
    // --- 3. コアロジック ---
    
    function handleTimeUpdate() {
        if (!state.lyrics.length || !document.body.classList.contains(CONFIG.layoutClass)) return;
        const video = document.querySelector('video');
        if (!video) return;
        let activeIndex = -1;
        for (let i = 0; i < state.lyrics.length; i++) {
            if (video.currentTime >= state.lyrics[i].time) activeIndex = i;
            else break;
        }
        if (activeIndex !== -1 && state.lyricLines[activeIndex]) {
            const activeLine = state.lyricLines[activeIndex];
            if (activeLine.classList.contains(CONFIG.activeClass)) return;
            state.lyricLines.forEach(l => l.classList.remove(CONFIG.activeClass));
            activeLine.classList.add(CONFIG.activeClass);
            const isMobile = window.innerWidth <= 950;
            activeLine.scrollIntoView({ behavior: activeIndex === 0 ? "auto" : CONFIG.scrollBehavior, block: "center", inline: isMobile ? "center" : "nearest" });
        }
    }

    async function onSongChanged() {
        if (state.isContextInvalidated) return;
        const titleEl = document.querySelector('yt-formatted-string.title.style-scope.ytmusic-player-bar');
        const subtitleEl = document.querySelector('.byline.style-scope.ytmusic-player-bar');
        if (!titleEl || !subtitleEl) return;
        
        const title = titleEl.textContent;
        const bylineText = subtitleEl.textContent;
        const bylineParts = bylineText.split('•').map(s => s.trim());
        const artist = bylineParts[0] || "";
        const album = (navigator.mediaSession.metadata && navigator.mediaSession.metadata.album) || (bylineParts.length > 1 ? bylineParts[1] : "");

        const songId = `${title}|||${artist}`;
        if (state.currentSongId === songId) return;

        state.currentSongId = songId;
        state.fetchRequestId++; 
        const currentRequestId = state.fetchRequestId;
        
        if(DOM.title) DOM.title.textContent = title;
        if(DOM.artist) DOM.artist.textContent = artist;
        if(DOM.lyrics) DOM.lyrics.innerHTML = '<div class="lyric-line">Loading...</div>';
        
        getVerifiedArtwork(title).then(url => {
            if (url && state.currentSongId === songId) {
                if (DOM.artwork) DOM.artwork.innerHTML = `<img src="${url}" crossorigin="anonymous">`;
                if (DOM.bg) DOM.bg.style.backgroundImage = `url(${url})`;
            }
        });
        
        // --- 再生時間(duration)の確定待ちループ ---
        let duration = 0;
        for (let i = 0; i < CONFIG.durationMaxRetries; i++) {
            const video = document.querySelector('video');
            if (video && video.duration && isFinite(video.duration)) {
                duration = video.duration;
                break; // 確定したらループを抜ける
            }
            // 短い待機
            await new Promise(r => setTimeout(r, 100));
        }

        if (state.fetchRequestId !== currentRequestId) return;
        
        try {
            chrome.runtime.sendMessage({ 
                action: "fetchLyrics", 
                title, artist, album,
                lang: navigator.language, 
                duration
            }, (response) => {
                if (chrome.runtime.lastError) { state.isContextInvalidated = true; showErrorState("Extension invalidated. Please reload."); return; }
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

    // --- 4. 監視 & 初期化 ---
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
            DOM.songObserver = new MutationObserver(onSongChanged);
            DOM.songObserver.observe(playerBar, { subtree: true, characterData: true, childList: true });
            onSongChanged();
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

        setInterval(() => {
            if (state.isContextInvalidated) return;
            detectAndApplyBarMode();
            const currentLayout = document.querySelector('ytmusic-app-layout');
            const currentPlayer = document.querySelector('ytmusic-player-bar');
            if (currentLayout !== DOM.appLayout || currentPlayer !== DOM.playerBar) {
                attachObservers();
            }
            const video = document.querySelector('video');
            if (video && !video.dataset.hasLrcListener) {
                video.addEventListener('timeupdate', () => requestAnimationFrame(handleTimeUpdate));
                video.dataset.hasLrcListener = "true";
            }
            updateLayout();
        }, CONFIG.watchInterval);
        
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'toggleMode') {
                state.isEnabled = request.isEnabled;
                updateLayout();
            } else if (request.action === 'getSongInfo') {
                const titleEl = document.querySelector('yt-formatted-string.title.style-scope.ytmusic-player-bar');
                const subtitleEl = document.querySelector('.byline.style-scope.ytmusic-player-bar');
                if (titleEl && subtitleEl && titleEl.textContent) {
                    const artworkEl = document.querySelector('ytmusic-player-bar .thumbnail-image-wrapper img');
                    sendResponse({
                        title: titleEl.textContent,
                        artist: subtitleEl.textContent.split('•')[0].trim(),
                        artwork: artworkEl ? artworkEl.src : null
                    });
                } else {
                    sendResponse(null);
                }
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