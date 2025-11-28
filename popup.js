/**
 * popup.js
 * 
 * v6.0 - Reactive Carousel UI
 * 
 * Overview:
 * Controls the popup UI, enabling users to switch between multiple
 * YouTube Music tabs. It consumes the centralized state from the
 * background script and updates in real-time.
 * 
 * Key Features:
 * - Carousel Navigation: Switch between active YTM tabs.
 * - Real-time Updates: Listens for 'storeUpdated' events.
 * - Focus Control: Bring specific tab to foreground.
 * - Immersive Mode Toggle: Controls the specific tab currently displayed.
 */
'use strict';

// --- DOM Elements ---
const DOM = {
    // Song Info
    artwork: document.getElementById('artwork'),
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    statusBadge: document.getElementById('status-badge'),
    
    // Navigation Controls
    prevBtn: document.getElementById('btn-prev'),
    nextBtn: document.getElementById('btn-next'),
    pageIndicator: document.getElementById('page-indicator'),
    focusBtn: document.getElementById('btn-focus'),
    
    // Settings
    modeToggle: document.getElementById('mode-toggle'),
    
    // Containers
    mainContainer: document.getElementById('main-container'),
    emptyState: document.getElementById('empty-state')
};

// --- State Management ---
let state = {
    players: [],      // Array of player objects from background
    currentIndex: 0,  // Index of the currently displayed player
    isInitialized: false
};

/**
 * Initializes the popup by fetching the initial snapshot
 * and requesting a force sync to ensure freshness.
 */
async function init() {
    // 1. Get initial data from Background Store
    chrome.runtime.sendMessage({ action: "getStoreSnapshot" }, (store) => {
        if (store) {
            updatePlayersList(store);
            state.isInitialized = true;
        }
    });

    // 2. Request Force Sync (Re-hydration) to wake up tabs
    chrome.runtime.sendMessage({ action: "broadcastForceSync" });

    // 3. Load global settings
    chrome.storage.local.get(['isEnabled'], (result) => {
        DOM.modeToggle.checked = result.isEnabled !== false;
    });
}

/**
 * Converts the store object into a sorted array and updates the state.
 * Validates the current index to prevent out-of-bounds errors.
 * @param {object} store - Key-value map of tabId -> PlayerState
 */
function updatePlayersList(store) {
    if (!store) return;

    // Convert to array
    const newPlayers = Object.values(store);

    // Sort logic: Playing > Paused, then by Last Updated
    // NOTE: We only sort on initial load to prevent UI jumping while viewing
    if (!state.isInitialized) {
        newPlayers.sort((a, b) => {
            if (a.status === 'playing' && b.status !== 'playing') return -1;
            if (a.status !== 'playing' && b.status === 'playing') return 1;
            return b.lastUpdated - a.lastUpdated;
        });
    } else {
        // If already initialized, try to maintain the current order relative to tabIds
        // or just append new ones. For simplicity in v6.0, we just reload the list
        // but clamp the index. (Advanced stable sort can be added if needed)
        // Here we prioritize keeping the current view valid.
        
        // Find where the current tab went
        if (state.players.length > 0) {
            const currentTabId = state.players[state.currentIndex]?.tabId;
            // Simple update: just replace list. In a real stable sort, we'd merge.
            // For now, let's re-sort to ensure 'closed' tabs are gone.
        }
    }

    state.players = newPlayers;
    
    // Clamp index (Safety against closed tabs)
    if (state.players.length === 0) {
        state.currentIndex = 0;
    } else if (state.currentIndex >= state.players.length) {
        state.currentIndex = state.players.length - 1;
    }

    renderUI();
}

/**
 * Renders the UI based on the current state.
 */
function renderUI() {
    if (state.players.length === 0) {
        DOM.mainContainer.style.display = 'none';
        DOM.emptyState.style.display = 'flex';
        return;
    }

    DOM.mainContainer.style.display = 'block';
    DOM.emptyState.style.display = 'none';

    const currentPlayer = state.players[state.currentIndex];
    
    // Update Text & Image
    DOM.title.textContent = currentPlayer.title || "Unknown Title";
    DOM.title.title = currentPlayer.title || "";
    DOM.artist.textContent = currentPlayer.artist || "Unknown Artist";
    DOM.artwork.src = currentPlayer.artwork || 'icons/placeholder.png';

    // Update Status Badge
    if (currentPlayer.status === 'playing') {
        DOM.statusBadge.textContent = 'PLAYING';
        DOM.statusBadge.className = 'badge playing';
    } else {
        DOM.statusBadge.textContent = 'PAUSED';
        DOM.statusBadge.className = 'badge paused';
    }

    // Update Navigation Controls
    if (state.players.length > 1) {
        DOM.prevBtn.style.visibility = 'visible';
        DOM.nextBtn.style.visibility = 'visible';
        DOM.pageIndicator.textContent = `${state.currentIndex + 1} / ${state.players.length}`;
    } else {
        DOM.prevBtn.style.visibility = 'hidden';
        DOM.nextBtn.style.visibility = 'hidden';
        DOM.pageIndicator.textContent = "";
    }
}

// --- Event Listeners ---

// 1. Navigation
DOM.prevBtn.addEventListener('click', () => {
    if (state.players.length <= 1) return;
    state.currentIndex = (state.currentIndex - 1 + state.players.length) % state.players.length;
    renderUI();
});

DOM.nextBtn.addEventListener('click', () => {
    if (state.players.length <= 1) return;
    state.currentIndex = (state.currentIndex + 1) % state.players.length;
    renderUI();
});

// 2. Focus Tab
DOM.focusBtn.addEventListener('click', () => {
    const player = state.players[state.currentIndex];
    if (player && player.tabId) {
        chrome.tabs.update(player.tabId, { active: true });
        chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { focused: true });
    }
});

// 3. Settings Toggle (Global)
DOM.modeToggle.addEventListener('change', () => {
    const isEnabled = DOM.modeToggle.checked;
    chrome.storage.local.set({ isEnabled: isEnabled });
    
    // Broadcast change to ALL tabs immediately
    chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { action: 'toggleMode', isEnabled: isEnabled });
        });
    });
});

// 4. Real-time Updates from Background
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'storeUpdated') {
        updatePlayersList(request.store);
    }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', init);