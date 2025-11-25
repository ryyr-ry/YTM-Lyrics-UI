(function() {
    'use strict';

    const CONFIG = {
        apiBase: "https://lrclib.net/api/search",
        scrollBehavior: "smooth",
        activeClass: "active",
        layoutClass: "ytm-custom-layout"
    };

    const DOM = {
        video: null,
        appLayout: null,
        lyricsContainer: null,
        customWrapper: null,
        customBg: null,
        title: null,
        artist: null,
        artwork: null,
        toggleBtn: null
    };

    let state = {
        isEnabled: true,
        currentSongId: null,
        lyrics: [],
        lyricLines: [],
        observer: null
    };

    // --- Utils ---
    
    // タイトルから余計な情報（Remasterなど）を削除するクリーナー
    function cleanTitle(text) {
        return text.replace(/\s*[\(\[-\{\<].*?[\)\]-\}\>].*/, "").trim();
    }

    // 時間変換 (00:00.00 -> seconds)
    function parseTime(timeStr) {
        const [min, sec] = timeStr.split(':');
        return parseInt(min) * 60 + parseFloat(sec);
    }

    // Lrcパース
    function parseLRC(lrcString) {
        const lines = lrcString.split('\n');
        const result = [];
        const timeRegex = /\[(\d{2}):(\d{2}\.\d{2,3})\]/;

        for (const line of lines) {
            const match = line.match(timeRegex);
            if (match) {
                const text = line.replace(timeRegex, '').trim();
                if (text) {
                    result.push({
                        time: parseTime(`${match[1]}:${match[2]}`),
                        text: text
                    });
                }
            }
        }
        return result;
    }

    // --- API Logic ---

    async function fetchLyrics(title, artist) {
        // 戦略1: そのまま検索
        let lyrics = await tryFetch(title, artist);
        
        // 戦略2: タイトルをクリーニングして検索 (戦略1がダメだった場合)
        if (!lyrics) {
            const cleanT = cleanTitle(title);
            const cleanA = cleanTitle(artist); // アーティスト名の (feat...) も消す
            if (cleanT !== title || cleanA !== artist) {
                lyrics = await tryFetch(cleanT, cleanA);
            }
        }

        return lyrics || [{ time: 0, text: "Lyrics not found" }];
    }

    async function tryFetch(title, artist) {
        try {
            const query = encodeURIComponent(`${title} ${artist}`);
            const res = await fetch(`${CONFIG.apiBase}?q=${query}`);
            const data = await res.json();
            
            // syncedLyricsがあるものを優先
            const match = data.find(item => item.syncedLyrics);
            return match ? parseLRC(match.syncedLyrics) : null;
        } catch (e) {
            console.error("Lyrics fetch failed:", e);
            return null;
        }
    }

    // --- DOM & UI Logic ---

    function createUI() {
        if (document.getElementById('ytm-custom-wrapper')) return;

        // 背景
        DOM.customBg = document.createElement('div');
        DOM.customBg.id = 'ytm-custom-bg';

        // メインラッパー
        DOM.customWrapper = document.createElement('div');
        DOM.customWrapper.id = 'ytm-custom-wrapper';

        // 左カラム（アートワーク＆情報）
        const leftCol = document.createElement('div');
        leftCol.id = 'ytm-custom-left-col';
        
        DOM.artwork = document.createElement('div');
        DOM.artwork.id = 'ytm-artwork-container';
        
        const infoArea = document.createElement('div');
        infoArea.id = 'ytm-custom-info-area';
        
        DOM.title = document.createElement('div');
        DOM.title.id = 'ytm-custom-title';
        DOM.artist = document.createElement('div');
        DOM.artist.id = 'ytm-custom-artist';

        infoArea.append(DOM.title, DOM.artist);
        leftCol.append(DOM.artwork, infoArea);

        // 右カラム（歌詞）
        DOM.lyricsContainer = document.createElement('div');
        DOM.lyricsContainer.id = 'my-lyrics-container';

        DOM.customWrapper.append(leftCol, DOM.lyricsContainer);
        document.body.append(DOM.customBg, DOM.customWrapper);
    }

    function injectToggleButton() {
        const rightControls = document.querySelector('.right-controls-buttons.style-scope.ytmusic-player-bar');
        if (!rightControls || document.getElementById('my-mode-toggle')) return;

        DOM.toggleBtn = document.createElement('button');
        DOM.toggleBtn.id = 'my-mode-toggle';
        DOM.toggleBtn.innerText = 'IMMERSION';
        DOM.toggleBtn.onclick = toggleMode;
        
        updateToggleStyle();
        rightControls.prepend(DOM.toggleBtn);
    }

    function toggleMode() {
        state.isEnabled = !state.isEnabled;
        updateLayoutVisibility();
        updateToggleStyle();
    }

    function updateToggleStyle() {
        if (!DOM.toggleBtn) return;
        if (state.isEnabled) {
            DOM.toggleBtn.classList.add('active');
        } else {
            DOM.toggleBtn.classList.remove('active');
        }
    }

    function updateLayoutVisibility() {
        const layout = document.querySelector('ytmusic-app-layout');
        const isPlayerOpen = layout && layout.hasAttribute('player-page-open');
        const shouldShow = state.isEnabled && isPlayerOpen;

        document.body.classList.toggle(CONFIG.layoutClass, shouldShow);
        
        // ボタンの表示制御
        if (DOM.toggleBtn) {
            DOM.toggleBtn.style.display = isPlayerOpen ? "inline-block" : "none";
        }
    }

    function renderLyrics(data) {
        if (!DOM.lyricsContainer) return;
        DOM.lyricsContainer.innerHTML = '';
        
        const frag = document.createDocumentFragment();
        data.forEach((line, index) => {
            const p = document.createElement('div');
            p.className = 'lyric-line';
            p.textContent = line.text;
            p.dataset.index = index;
            p.onclick = () => {
                const video = document.querySelector('video');
                if (video) video.currentTime = line.time;
            };
            frag.appendChild(p);
        });
        DOM.lyricsContainer.appendChild(frag);
        state.lyricLines = Array.from(DOM.lyricsContainer.children);
    }

    // --- Core Logic ---

    function handleTimeUpdate() {
        if (!document.body.classList.contains(CONFIG.layoutClass)) return;
        if (!state.lyrics.length) return;

        const video = document.querySelector('video');
        if (!video) return;

        const currentTime = video.currentTime;
        let activeIndex = -1;

        // バイナリサーチまたは単純ループで現在の行を探す
        // (行数が少ないので単純ループで十分かつ高速)
        for (let i = 0; i < state.lyrics.length; i++) {
            if (currentTime >= state.lyrics[i].time) {
                activeIndex = i;
            } else {
                break;
            }
        }

        if (activeIndex !== -1 && state.lyricLines[activeIndex]) {
            const activeLine = state.lyricLines[activeIndex];
            
            // 既にActiveなら何もしない（DOM操作削減）
            if (activeLine.classList.contains(CONFIG.activeClass)) return;

            state.lyricLines.forEach(l => l.classList.remove(CONFIG.activeClass));
            activeLine.classList.add(CONFIG.activeClass);

            activeLine.scrollIntoView({
                behavior: CONFIG.scrollBehavior,
                block: "center"
            });
        }
    }

    async function onSongChanged() {
        const titleEl = document.querySelector('yt-formatted-string.title.style-scope.ytmusic-player-bar');
        const subtitleEl = document.querySelector('.byline.style-scope.ytmusic-player-bar');
        
        if (!titleEl || !subtitleEl) return;

        const title = titleEl.textContent;
        // アーティスト情報は "Artist • Album • Year" のようになっていることが多い
        const artist = subtitleEl.textContent.split('•')[0].trim();
        const songId = `${title}|||${artist}`;

        // 同じ曲ならスキップ
        if (state.currentSongId === songId) return;
        state.currentSongId = songId;

        // UI更新 (Loading状態)
        if(DOM.title) DOM.title.textContent = title;
        if(DOM.artist) DOM.artist.textContent = artist;
        if(DOM.lyricsContainer) DOM.lyricsContainer.innerHTML = '<div class="lyric-line">Loading...</div>';

        // アートワーク取得 (MediaSession APIの方が高画質な場合が多い)
        let artworkUrl = "";
        if ('mediaSession' in navigator && navigator.mediaSession.metadata?.artwork?.length) {
            const arts = navigator.mediaSession.metadata.artwork;
            artworkUrl = arts[arts.length - 1].src;
        } else {
            const img = document.querySelector('.thumbnail-image-wrapper img');
            if (img) artworkUrl = img.src;
        }

        if (artworkUrl) {
            if (DOM.artwork) DOM.artwork.innerHTML = `<img src="${artworkUrl}" crossorigin="anonymous">`;
            if (DOM.customBg) DOM.customBg.style.backgroundImage = `url(${artworkUrl})`;
        }

        // 歌詞取得
        const lyrics = await fetchLyrics(title, artist);
        // 通信中に曲が変わっていたら反映しない
        if (state.currentSongId === songId) {
            state.lyrics = lyrics;
            renderLyrics(lyrics);
        }
    }

    // --- Initialization ---

    function init() {
        createUI();
        injectToggleButton();

        // 1. レイアウト監視 (MutationObserver)
        // ytmusic-app-layout の属性変化(player-page-open)を監視
        const appLayout = document.querySelector('ytmusic-app-layout');
        if (appLayout) {
            const layoutObserver = new MutationObserver(() => {
                injectToggleButton(); // 画面遷移でボタンが消えることがあるため再注入
                updateLayoutVisibility();
            });
            layoutObserver.observe(appLayout, { attributes: true, attributeFilter: ['player-page-open'] });
        }

        // 2. 曲変更監視 (MutationObserver)
        // プレイヤーバーのテキスト変更を監視
        const playerBar = document.querySelector('ytmusic-player-bar');
        if (playerBar) {
            const songObserver = new MutationObserver(() => {
                onSongChanged();
                injectToggleButton();
            });
            songObserver.observe(playerBar, { subtree: true, characterData: true, childList: true });
        }

        // 3. 再生時間監視
        // videoタグは動的に生成されることは少ないが、念の為存在確認
        const setupVideoListener = () => {
            const video = document.querySelector('video');
            if (video && !video.dataset.hasLrcListener) {
                video.addEventListener('timeupdate', () => {
                    // requestAnimationFrameで描画タイミングを最適化
                    requestAnimationFrame(handleTimeUpdate);
                });
                video.dataset.hasLrcListener = "true";
            }
        };
        // videoが見つかるまで、または再生成に備えて定期チェック(ここだけInterval使うが軽量)
        setInterval(setupVideoListener, 2000);

        // 初回実行
        onSongChanged();
        updateLayoutVisibility();
    }

    // ページのロード完了を待つ
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();