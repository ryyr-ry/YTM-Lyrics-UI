<div align="right">
    <strong>English</strong> | <a href="./README.ja.md">日本語</a>
</div>

# YTM Lyrics + UI (Beta)

This extension is designed to refresh the YouTube Music interface and add synchronized lyrics functionality. Please note that this is currently a beta release and several known issues exist.

---

## Key Features

*   **Synchronized Lyrics**
    Displays time-synced lyrics using the LRCLIB API. You can click on any line to instantly seek to that position in the track.
*   **Immersive Full-Screen UI**
    Provides a modern, Apple Music-style full-screen player with dynamic backgrounds generated from the album artwork.
*   **Improved Search Logic**
    Combines `GET /api/get` and `GET /api/search` methods to ensure more reliable lyric retrieval.
*   **Responsive Design**
    Automatically adjusts the layout based on window width. It switches between a side-by-side view for desktop and a vertical scrolling view optimized for narrower mobile-like widths. Note: Due to known issues with the mobile layout, use on smartphones or very narrow windows is currently not recommended.
*   **Lyrics Caching**
    To mitigate API delays, fetched lyrics are cached locally for instant display upon subsequent playback.

> **⚠️ Known Issues**
> As this is a beta release, please be aware of the following:
> *   **Lyric Accuracy:** For many tracks, lyrics may not be found or incorrect lyrics may be displayed.
> *   **Mobile Layout Behavior:** When the window width is narrow (mobile view), the player bar buttons may disappear or the layout may break during certain interactions.

## Installation

This extension is not currently available on the Chrome Web Store. Please follow these steps for manual installation:

1.  **Download**
    *   Click the green **`<> Code`** button at the top of this repository page.
    *   Select **`Download ZIP`** and extract the contents to a folder of your choice.
2.  **Load the Extension**
    *   Open your browser (Chrome, Edge, Brave, etc.) and navigate to `chrome://extensions/`.
    *   Toggle **"Developer mode"** in the top right corner.
    *   Click **"Load unpacked"**.
    *   Select the extracted folder (the one containing `manifest.json`).
3.  **Done**
    *   Open YouTube Music and play a song. The new UI will be applied automatically.

## Project Background

This project is a **hard fork** created to ensure code stability and resolve potential intellectual property rights concerns.

### Original Source
This software is based on [naikaku1/YouTube_Music-Moden-UI](https://github.com/naikaku1/YouTube_Music-Moden-UI).

### Reason for Hard Fork
The original repository merged pull requests with unclear CLA (Contributor License Agreement) status and rights ownership, posing a potential future risk.
To eliminate this risk and continue development from a clean state, this repository was forked starting from commit **`5ff9249`**, the last commit made solely by the original author, Naikaku.

Since forking, significant refactoring has been performed, including design changes and logic improvements.

## License

This project is released under the **Apache License 2.0**.
See the `LICENSE` file for details.

**Credits:**
This software includes code released under the **MIT License**.
*   **Original Project:** [YouTube_Music-Moden-UI](https://github.com/naikaku1/YouTube_Music-Moden-UI)
*   **Original Author:** Naikaku
*   The original license text is preserved in `LICENSE_ORIGINAL.md`.