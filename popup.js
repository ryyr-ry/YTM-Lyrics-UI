/**
 * popup.js
 * 
 * 役割:
 * 1. 拡張機能のポップアップUIの動作を制御する。
 * 2. Immersive ModeのON/OFF状態を chrome.storage に保存・読込する。
 * 3. YouTube Musicタブと通信し、現在の曲情報を表示する。
 */
'use strict';

const modeToggle = document.getElementById('mode-toggle');
const artworkEl = document.getElementById('artwork');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');

/**
 * YouTube Musicタブにメッセージを送信する共通関数
 * @param {object} message - 送信するメッセージオブジェクト
 * @param {function} callback - レスポンスを受け取るコールバック
 */
function sendMessageToContentScript(message, callback) {
  // 現在アクティブなYouTube Musicのタブを検索
  chrome.tabs.query({ active: true, url: "*://music.youtube.com/*" }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, message, callback);
    } else {
      // YTMタブが見つからない場合は何もしない
      console.log("YouTube Music tab not found.");
    }
  });
}

/**
 * ポップアップの曲情報UIを更新する
 * @param {object} songInfo - { title, artist, artwork }
 */
function updateSongInfoUI(songInfo) {
  if (songInfo && songInfo.title) {
    titleEl.textContent = songInfo.title;
    titleEl.title = songInfo.title; // ツールチップ用
    artistEl.textContent = songInfo.artist;
    artworkEl.src = songInfo.artwork || 'icons/placeholder.png';
  } else {
    titleEl.textContent = "No song playing...";
    titleEl.title = "No song playing...";
    artistEl.textContent = "";
    artworkEl.src = 'icons/placeholder.png';
  }
}

// --- イベントリスナー ---

// トグルスイッチが変更されたときの処理
modeToggle.addEventListener('change', () => {
  const isEnabled = modeToggle.checked;
  
  // 1. 設定をストレージに保存
  chrome.storage.local.set({ isEnabled: isEnabled });

  // 2. Content Scriptにモード変更を通知 (UIを即時反映させるため)
  // ※ storage.onChangedでも検知するが、即時性を高めるためにメッセージも送る
  sendMessageToContentScript({ action: 'toggleMode', isEnabled: isEnabled });
});

// ポップアップを開いたときの初期化処理
document.addEventListener('DOMContentLoaded', () => {
  // 1. ストレージから現在の設定を読み込み、スイッチに反映
  chrome.storage.local.get(['isEnabled'], (result) => {
    // 保存された値がなければデフォルトでON(true)にする
    modeToggle.checked = result.isEnabled !== false;
  });

  // 2. Content Scriptに現在の曲情報を問い合わせる
  sendMessageToContentScript({ action: 'getSongInfo' }, (response) => {
    if (chrome.runtime.lastError) {
      // Content Scriptがまだ読み込まれていない等のエラー
      console.warn(chrome.runtime.lastError.message);
      updateSongInfoUI(null);
    } else {
      updateSongInfoUI(response);
    }
  });
});