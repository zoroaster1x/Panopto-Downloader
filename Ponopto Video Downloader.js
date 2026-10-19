// ==UserScript==
// @name         Panopto Video Downloader
// @namespace    http://tampermonkey.net/
// @version      3.2.1
// @description  Download the combined, camera or slides stream (HLS resolved to MP4), resize the viewer, hide a stream, and keep both players in sync.
// @author       Zoroaster1x
// @license      GPL-3.0
// @match        https://*.panopto.eu/Panopto/Pages/Viewer.aspx?*
// @match        https://*.panopto.com/Panopto/Pages/Viewer.aspx?*
// @match        https://*.panopto.eu/Panopto/Pages/Embed.aspx?*
// @match        https://*.panopto.com/Panopto/Pages/Embed.aspx?*
// @icon         https://www.panopto.com/favicon.ico
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      self
// @connect      panopto.eu
// @connect      panopto.com
// @connect      *.panopto.eu
// @connect      *.panopto.com
// @connect      cloudfront.net
// @connect      *.cloudfront.net
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
       CONSTANTS
       ============================================================ */

    const IS_TOP = (() => {
        try { return window.top === window.self; } catch (e) { return true; }
    })();

    // Tampermonkey/Violentmonkey run us in an isolated world; Panopto's own
    // listeners live on the page window, so click/resize events must go there.
    const PAGE_WINDOW = (() => {
        try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window; }
        catch (e) { return window; }
    })();

    function dispatchResize() {
        try {
            PAGE_WINDOW.dispatchEvent(new Event('resize'));
        } catch (e) { /* ignore */ }
    }

    const K = {
        history: 'pdl.history.v4',
        dark: 'pdl.dark.v3',
        layout: 'pdl.layout.v1',
        panelPos: 'pdl.panel.pos.v1',
        saveAs: 'pdl.saveAs.v1',
        lastTab: 'pdl.lastTab.v1',
    };

    const MAX_HISTORY = 60;
    const BC_NAME = 'pdl.sync.v1';
    const TAB_ID = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    /* ============================================================
       SMALL UTILITIES
       ============================================================ */

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    function clamp(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    function isEditable(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.isContentEditable) return true;
        if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)) return true;
        return !!el.closest('[contenteditable="true"]');
    }

    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }

    function formatBytes(bytes) {
        if (!bytes || !isFinite(bytes) || bytes < 0) return '';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
        const value = bytes / Math.pow(1024, i);
        return value.toFixed(i === 0 ? 0 : value >= 100 ? 0 : 1) + ' ' + units[i];
    }

    function formatSpeed(bps) {
        if (!bps || !isFinite(bps) || bps <= 0) return '';
        return formatBytes(bps) + '/s';
    }

    function formatEta(sec) {
        if (!sec || !isFinite(sec) || sec <= 0) return '';
        sec = Math.round(sec);
        if (sec < 60) return sec + 's';
        if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
        return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    }

    function sanitizeFilename(name, fallback) {
        let s = String(name || '').replace(/[\x00-\x1f\x80-\x9f]/g, '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
        s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
        if (!s) s = fallback || 'panopto-video';
        return s.slice(0, 160).trim();
    }

    function toast(message, kind) {
        if (!IS_TOP) return;
        let host = document.getElementById('pdl-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'pdl-toasts';
            document.body.appendChild(host);
        }
        const t = document.createElement('div');
        t.className = 'pdl-toast' + (kind ? ' pdl-toast-' + kind : '');
        t.textContent = message;
        host.appendChild(t);
        setTimeout(() => {
            t.classList.add('pdl-toast-out');
            setTimeout(() => t.remove(), 220);
        }, 2800);
    }

    function copyText(text) {
        try {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(text, 'text');
                return true;
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* fall through */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            return true;
        } catch (e) {
            return false;
        }
    }

    /* ============================================================
       GM WRAPPERS (Firefox: Tampermonkey / Violentmonkey / Greasemonkey)
       ============================================================ */

    const store = {
        get(key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    const v = GM_getValue(key);
                    return v === undefined ? fallback : v;
                }
                const raw = localStorage.getItem(key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch (e) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, value);
                } else {
                    localStorage.setItem(key, JSON.stringify(value));
                }
            } catch (e) { /* ignore quota / private mode */ }
        }
    };

    function gmXhr(options) {
        const fn = (typeof GM_xmlhttpRequest === 'function')
            ? GM_xmlhttpRequest
            : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);
        if (fn) return fn(options);

        // Plain fallback (same-origin only). Enough for DeliveryInfo and HEAD.
        const controller = new AbortController();
        fetch(options.url, {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.data,
            credentials: 'include',
            signal: controller.signal
        }).then(async (res) => {
            const text = await res.text();
            if (options.onload) {
                options.onload({
                    status: res.status,
                    responseText: text,
                    responseHeaders: Array.from(res.headers.entries()).map(([k, v]) => k + ': ' + v).join('\r\n')
                });
            }
        }).catch(() => {
            if (options.onerror) options.onerror({});
        });

        return { abort: () => controller.abort() };
    }

    function addStyle(css) {
        const inject = (parent) => {
            const style = document.createElement('style');
            style.textContent = css;
            parent.appendChild(style);
            return style;
        };
        // @run-at document-start: the root element can still be missing here.
        const parent = document.head || document.documentElement;
        if (parent) return inject(parent);
        const observer = new MutationObserver(() => {
            const p = document.head || document.documentElement;
            if (p) {
                observer.disconnect();
                inject(p);
            }
        });
        observer.observe(document, { childList: true });
        return null;
    }

    function registerMenu(label, fn) {
        try {
            if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn);
        } catch (e) { /* ignore */ }
    }

    /* ============================================================
       ICONS
       ============================================================ */

    const ICONS = {
        download: '<path d="M12 3v11m0 0 4-4m-4 4-4-4"/><path d="M5 17v3h14v-3"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7L11 6"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.5-1.5"/>',
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
        history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
        layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
        camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
        screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
        combined: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
        caption: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h3M7 14h10M13.5 10H17"/>',
        check: '<path d="m4 12 5 5L20 6"/>',
        alert: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 17.5v.5"/>',
        chevronLeft: '<path d="m15 5-7 7 7 7"/>',
        chevronRight: '<path d="m9 5 7 7-7 7"/>',
        refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 15"/><path d="M3 4v5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 9"/><path d="M21 20v-5h-5"/>',
        trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/>',
        grip: '<circle cx="9" cy="6" r="1.1"/><circle cx="15" cy="6" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="18" r="1.1"/><circle cx="15" cy="18" r="1.1"/>',
        play: '<path d="m8 5 11 7-11 7V5Z"/>',
        pause: '<path d="M8 5v14M16 5v14"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
        spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'
    };

    function icon(name, size, cls) {
        return '<svg class="pdl-svg ' + (cls || '') + '" width="' + (size || 18) + '" height="' + (size || 18) +
            '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    }

    /* ============================================================
       ACCENT (use the institution's Panopto colour, not a random green)
       ============================================================ */

    let ACCENT_RGB = [33, 206, 153];

    function detectAccent() {
        const selectors = ['.accent-background', '#elapsedBar', '#positionHandle', '.branded-button'];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const bg = getComputedStyle(el).backgroundColor;
            const m = bg.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
            if (!m) continue;
            const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
            if (rgb.every(v => v === 0) || rgb.every(v => v === 255)) continue;
            return rgb;
        }
        return [33, 206, 153];
    }

    function mixWithWhite(rgb, amount) {
        return rgb.map(v => Math.round(v + (255 - v) * amount));
    }

    function setAccentVars() {
        ACCENT_RGB = detectAccent();
        const soft = mixWithWhite(ACCENT_RGB, 0.48);
        const lum = (0.2126 * ACCENT_RGB[0] + 0.7152 * ACCENT_RGB[1] + 0.0722 * ACCENT_RGB[2]) / 255;
        const root = document.documentElement;
        root.style.setProperty('--pdl-accent', 'rgb(' + ACCENT_RGB.join(',') + ')');
        root.style.setProperty('--pdl-accent-rgb', ACCENT_RGB.join(','));
        root.style.setProperty('--pdl-accent-soft', 'rgb(' + soft.join(',') + ')');
        root.style.setProperty('--pdl-accent-soft-rgb', soft.join(','));
        root.style.setProperty('--pdl-on-accent', lum > 0.58 ? '#0d0d11' : '#ffffff');
    }

    /* ============================================================
       DARK MODE FOR PANOPTO ITSELF
       ============================================================ */

    const SITE_CSS = `
        body.pdl-dark { background: #0f0f14 !important; }

        /* Sidebar / tabs */
        body.pdl-dark aside[role="complementary"] {
            background: #16161d !important;
            color: #e6e6ec !important;
            border-left: 1px solid rgba(255,255,255,0.06) !important;
        }
        body.pdl-dark #eventTabControl {
            background: linear-gradient(180deg, #1c1c24 0%, #16161d 100%) !important;
            border-bottom: 1px solid rgba(255,255,255,0.06) !important;
        }
        body.pdl-dark .event-tab-header {
            color: rgba(230, 230, 236, 0.58) !important;
            background: transparent !important;
            border-color: rgba(255,255,255,0.06) !important;
            transition: color .15s ease, background .15s ease;
        }
        body.pdl-dark .event-tab-header:hover {
            color: #fff !important;
            background: rgba(255,255,255,0.055) !important;
        }
        body.pdl-dark .event-tab-header.selected,
        body.pdl-dark .event-tab-header.active,
        body.pdl-dark .event-tab-header[aria-selected="true"] {
            color: var(--pdl-accent-soft) !important;
            background: rgba(var(--pdl-accent-rgb), 0.10) !important;
            box-shadow: inset 0 -2px 0 var(--pdl-accent);
        }
        body.pdl-dark .event-tab-header .text { color: inherit !important; }
        body.pdl-dark #eventsExpanderButton > div { color: rgba(230, 230, 236, 0.55) !important; }
        body.pdl-dark #eventsExpanderButton > div:hover { color: #fff !important; }
        body.pdl-dark #advancedEditorLink a { color: var(--pdl-accent-soft) !important; }

        body.pdl-dark #eventTabPanes,
        body.pdl-dark .event-tab-pane { background: #16161d !important; color: #e6e6ec !important; }
        body.pdl-dark #eventTabPanes { overflow: hidden !important; }
        /* Narrow sidebar: let the event text wrap instead of overflowing. */
        body.pdl-dark #eventTabPanes .index-event-row { flex-wrap: wrap; }
        body.pdl-dark #eventTabPanes .event-text {
            min-width: 0 !important;
            white-space: normal !important;
            overflow-wrap: anywhere;
            word-break: break-word;
        }
        body.pdl-dark #eventTabPanes .event-text span,
        body.pdl-dark #eventTabPanes .event-user { white-space: normal !important; overflow-wrap: anywhere; }
        body.pdl-dark #eventTabPanes .event-time { margin-left: auto; }
        /* Active pane: header/textarea stay, the scroll area takes the rest. */
        body.pdl-managed #eventTabPanes .event-tab-pane:not([style*="display: none"]):not([style*="display:none"]) {
            display: flex !important;
            flex-direction: column;
        }
        body.pdl-managed #eventTabPanes .event-tab-pane .event-tab-scroll-pane {
            flex: 1 1 auto;
            height: auto !important;
            min-height: 0;
        }
        body.pdl-dark #eventTabPanes .event-tab-scroll-pane,
        body.pdl-dark #eventTabPanes .event-tab-pane {
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,.22) transparent;
        }
        body.pdl-dark #eventTabPanes ::-webkit-scrollbar { width: 8px; height: 8px; }
        body.pdl-dark #eventTabPanes ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.22); border-radius: 4px; }
        body.pdl-dark #eventTabPanes ::-webkit-scrollbar-track { background: transparent; }
        body.pdl-dark .event-tab-scroll-pane { background: transparent !important; }
        body.pdl-dark .event-tab-pane-header {
            background: linear-gradient(180deg, #1c1c24 0%, #16161d 100%) !important;
            border-bottom: 1px solid rgba(255,255,255,0.06) !important;
            color: #e6e6ec !important;
        }

        body.pdl-dark .event-tab-list { background: transparent !important; color: #e6e6ec !important; }
        body.pdl-dark .index-event,
        body.pdl-dark .event-tab-list > li {
            color: #dcdce4 !important;
            background: #16161d !important;
            background-color: #16161d !important;
            background-image: none !important;
            border-color: rgba(255,255,255,0.05) !important;
            transition: background .12s ease, color .12s ease;
        }
        body.pdl-dark .index-event:hover,
        body.pdl-dark .event-tab-list > li:hover {
            background-color: rgba(var(--pdl-accent-rgb), 0.10) !important;
            color: #fff !important;
        }
        body.pdl-dark .index-event.selected,
        body.pdl-dark .index-event.selected:hover,
        body.pdl-dark .event-tab-list > li.selected,
        body.pdl-dark .event-tab-list > li.selected:hover {
            background-color: rgba(var(--pdl-accent-rgb), 0.16) !important;
            color: #fff !important;
            border-left: 3px solid var(--pdl-accent) !important;
        }
        body.pdl-dark .event-tab-list > li:hover *,
        body.pdl-dark .index-event:hover * { background-color: transparent !important; }
        body.pdl-dark .event-text,
        body.pdl-dark .event-time,
        body.pdl-dark .event-timestamp { color: #dcdce4 !important; }
        body.pdl-dark .event-user { color: rgba(230, 230, 236, 0.55) !important; }
        body.pdl-dark .event-tab-list i.material-icons,
        body.pdl-dark .index-event i.material-icons { color: rgba(230, 230, 236, 0.7) !important; }
        body.pdl-dark .event-tab-help,
        body.pdl-dark #allBookmarksLink { color: var(--pdl-accent-soft) !important; }

        /* Search */
        body.pdl-dark #searchRegion {
            background: #1c1c24 !important;
            border-bottom: 1px solid rgba(255,255,255,0.06) !important;
            padding: 8px 10px !important;
            box-sizing: border-box !important;
        }
        body.pdl-dark #searchInput {
            background: #101017 !important;
            color: #e6e6ec !important;
            border: 1px solid rgba(255,255,255,0.10) !important;
            border-radius: 6px !important;
            padding: 8px 12px !important;
            outline: none !important;
            box-shadow: none !important;
            box-sizing: border-box !important;
            width: 100% !important;
        }
        body.pdl-dark #searchInput::placeholder { color: rgba(230,230,236,0.35) !important; }
        body.pdl-dark #searchInput:focus {
            border-color: var(--pdl-accent) !important;
            box-shadow: 0 0 0 2px rgba(var(--pdl-accent-rgb), 0.20) !important;
        }
        body.pdl-dark #clearButton,
        body.pdl-dark #placeholderSearchButton { color: rgba(230,230,236,0.55) !important; }
        body.pdl-dark #searchButton { color: #0d0d11 !important; }

        /* Header */
        body.pdl-dark #viewerHeader {
            background: #16161d !important;
            border-bottom: 1px solid rgba(255,255,255,0.06) !important;
            color: #e6e6ec !important;
        }
        body.pdl-dark #deliveryTitle { color: #fff !important; }
        body.pdl-dark #viewerHeader .action-icon,
        body.pdl-dark #header-right .action-icon,
        body.pdl-dark #header-right-react .action-icon,
        body.pdl-dark .header-right .action-icon,
        body.pdl-dark .header-right i.material-icons,
        body.pdl-dark #viewerHeader i.material-icons { color: rgba(230,230,236,0.85) !important; }
        body.pdl-dark #viewerHeader .action-icon:hover,
        body.pdl-dark #header-right .action-icon:hover,
        body.pdl-dark .header-right .action-icon:hover,
        body.pdl-dark #viewerHeader i.material-icons:hover { color: var(--pdl-accent-soft) !important; }
        body.pdl-dark #shareButton svg path,
        body.pdl-dark #editButton svg path,
        body.pdl-dark #header-right svg path { fill: rgba(230,230,236,0.85) !important; }
        body.pdl-dark #shareButton:hover svg path,
        body.pdl-dark #editButton:hover svg path { fill: var(--pdl-accent-soft) !important; }

        /* Player controls */
        body.pdl-dark #playControlsWrapper,
        body.pdl-dark #playControls {
            background: #16161d !important;
            border-top: 1px solid rgba(255,255,255,0.06) !important;
            color: #e6e6ec !important;
        }
        body.pdl-dark #playControls .transport-button,
        body.pdl-dark #playControls i.material-icons { color: rgba(230,230,236,0.85) !important; }
        body.pdl-dark #playControls .transport-button:hover { color: var(--pdl-accent-soft) !important; }
        body.pdl-dark #timeElapsed,
        body.pdl-dark #timeRemaining { color: rgba(230,230,236,0.85) !important; }
        body.pdl-dark #positionSlider,
        body.pdl-dark #volumeSlider { background: transparent !important; }
        body.pdl-dark #positionBar,
        body.pdl-dark #volumeBar,
        body.pdl-dark .total-bar {
            background: rgba(255,255,255,0.10) !important;
            background-color: rgba(255,255,255,0.10) !important;
            background-image: none !important;
            border: none !important;
            box-shadow: none !important;
        }
        body.pdl-dark #positionBar::before,
        body.pdl-dark #positionBar::after,
        body.pdl-dark #volumeBar::before,
        body.pdl-dark #volumeBar::after { display: none !important; background: transparent !important; }
        body.pdl-dark #hoverTick { background: rgba(255,255,255,0.25) !important; }
        body.pdl-dark #positionHandle .slider-handle-center {
            background: var(--pdl-accent) !important;
            border-color: var(--pdl-accent) !important;
            box-shadow: 0 0 8px rgba(var(--pdl-accent-rgb), 0.6) !important;
        }
        body.pdl-dark #dockedCaption { background: #101017 !important; color: #e6e6ec !important; }
        body.pdl-dark #leftPane { background: #16161d !important; }
        body.pdl-dark #rightPane { background: #0f0f14 !important; }
        body.pdl-dark #rightPlayersContainer { background: #000 !important; }
        body.pdl-dark #thumbnailList { background: #16161d !important; }
        body.pdl-dark .thumbnail {
            background: #101017 !important;
            border-color: rgba(255,255,255,0.06) !important;
            color: #e6e6ec !important;
        }
        body.pdl-dark .thumbnail:hover { border-color: rgba(var(--pdl-accent-rgb), 0.4) !important; }

        /* Brand chrome */
        body.pdl-dark .powered-by-panopto,
        body.pdl-dark .powered-by,
        body.pdl-dark [class*="poweredBy"],
        body.pdl-dark [class*="powered-by"],
        body.pdl-dark #panoptoLogoLink,
        body.pdl-dark .panopto-logo span,
        body.pdl-dark .customer-logo .cobrand-link,
        body.pdl-dark .cobrand-link span { color: rgba(230,230,236,0.55) !important; }
        body.pdl-dark #panoptoLogoLink svg,
        body.pdl-dark .panopto-logo svg image { filter: brightness(0) invert(1) opacity(0.55) !important; }
        body.pdl-dark .customer-logo img { filter: brightness(0) invert(1) opacity(0.85) !important; }

        /* Notes */
        body.pdl-dark #notesTabPane,
        body.pdl-dark #notesTabPane .event-tab-scroll-pane { background: #16161d !important; color: #e6e6ec !important; }
        body.pdl-dark #notesPaneHeader {
            background: linear-gradient(180deg, #1c1c24 0%, #16161d 100%) !important;
            border-bottom: 1px solid rgba(255,255,255,0.06) !important;
            color: #e6e6ec !important;
            display: flex !important;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px 8px;
            padding: 8px !important;
        }
        body.pdl-dark #notesPaneHeader #channelSelect {
            flex: 1 1 calc(100% - 44px);
            min-width: 0;
            max-width: 100%;
            font-size: 11px !important;
        }
        body.pdl-dark #notesPaneHeader #notesDownload { flex: none; margin-left: auto; }
        body.pdl-dark #notesPaneHeader #togglePublic,
        body.pdl-dark #notesPaneHeader .event-tab-help {
            flex: none;
            float: none !important;
            font-size: 11px;
        }
        body.pdl-dark #notesPaneHeader .event-tab-help { margin-left: auto; }
        body.pdl-dark #notesTabPane textarea.event-input {
            width: calc(100% - 12px) !important;
            min-height: 84px !important;
            height: auto !important;
            margin: 6px !important;
            line-height: 1.5;
            resize: vertical;
        }
        body.pdl-dark #channelSelect,
        body.pdl-dark #channelInput {
            background: #101017 !important;
            color: #e6e6ec !important;
            border: 1px solid rgba(255,255,255,0.12) !important;
            border-radius: 6px !important;
            padding: 4px 8px !important;
            outline: none !important;
        }
        body.pdl-dark #channelSelect option { background: #101017 !important; color: #e6e6ec !important; }
        body.pdl-dark #togglePublic,
        body.pdl-dark #notesDownload,
        body.pdl-dark #notesTabPane .event-tab-help,
        body.pdl-dark #cancelChannel { color: var(--pdl-accent-soft) !important; }
        body.pdl-dark #notesTabPane textarea.event-input,
        body.pdl-dark .event-tab-pane textarea.event-input {
            background: #101017 !important;
            color: #e6e6ec !important;
            border: 1px solid rgba(255,255,255,0.08) !important;
            border-radius: 8px !important;
            padding: 10px 12px !important;
            box-sizing: border-box !important;
        }
        body.pdl-dark #notesTabPane textarea.event-input::placeholder,
        body.pdl-dark .event-tab-pane textarea.event-input::placeholder { color: rgba(230,230,236,0.4) !important; }
        body.pdl-dark #notesTabPane textarea.event-input:focus {
            border-color: var(--pdl-accent) !important;
            box-shadow: 0 0 0 2px rgba(var(--pdl-accent-rgb), 0.18) !important;
            outline: none !important;
        }

        /* Discussion / MUI */
        body.pdl-dark #threadedComments,
        body.pdl-dark #threadedComments *,
        body.pdl-dark #notesTabPane,
        body.pdl-dark #notesTabPane * { overflow-wrap: anywhere; }
        body.pdl-dark #threadedComments,
        body.pdl-dark #threadedCommentsPane,
        body.pdl-dark #commentsTabPane,
        body.pdl-dark #commentsTabPane .event-overlay,
        body.pdl-dark #commentsTabPane .event-pane-container,
        body.pdl-dark #commentsTabPane .event-pane { background: #16161d !important; color: #e6e6ec !important; }
        body.pdl-dark #threadedComments .input-container {
            background: #1c1c24 !important;
            border-bottom: 1px solid rgba(255,255,255,0.06) !important;
        }
        body.pdl-dark #threadedComments .input-container .input,
        body.pdl-dark #threadedComments textarea.input {
            background: #101017 !important;
            color: #e6e6ec !important;
            border: 1px solid rgba(255,255,255,0.10) !important;
            border-radius: 8px !important;
            padding: 10px 12px !important;
            box-sizing: border-box !important;
        }
        body.pdl-dark #threadedComments textarea.input::placeholder { color: rgba(230,230,236,0.4) !important; }
        body.pdl-dark #threadedComments .input-controls { background: transparent !important; color: #e6e6ec !important; }
        body.pdl-dark #threadedComments .input-time { color: rgba(230,230,236,0.65) !important; }
        body.pdl-dark #threadedComments .submit-button { color: rgba(230,230,236,0.55) !important; }
        body.pdl-dark #threadedComments .submit-button:not(.disabled) { color: var(--pdl-accent-soft) !important; }
        body.pdl-dark .MuiInputBase-root,
        body.pdl-dark .MuiOutlinedInput-root,
        body.pdl-dark .MuiSelect-select,
        body.pdl-dark .MuiInputBase-input {
            background: #101017 !important;
            color: #e6e6ec !important;
            border-radius: 6px !important;
        }
        body.pdl-dark .MuiOutlinedInput-notchedOutline { border-color: rgba(255,255,255,0.12) !important; }
        body.pdl-dark .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline { border-color: rgba(255,255,255,0.20) !important; }
        body.pdl-dark .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline { border-color: var(--pdl-accent) !important; }
        body.pdl-dark .MuiSvgIcon-root { color: rgba(230,230,236,0.65) !important; }
        body.pdl-dark .visibility-menu-item-flex .label,
        body.pdl-dark .visibility-menu-item-flex .sub-label { color: #e6e6ec !important; }
        body.pdl-dark .visibility-menu-item-flex .sub-label { color: rgba(230,230,236,0.55) !important; }
        body.pdl-dark .MuiMenu-paper,
        body.pdl-dark .MuiPopover-paper {
            background: #1c1c24 !important;
            color: #e6e6ec !important;
            border: 1px solid rgba(255,255,255,0.08) !important;
        }
        body.pdl-dark .MuiMenuItem-root { color: #e6e6ec !important; }
        body.pdl-dark .MuiMenuItem-root:hover { background: rgba(var(--pdl-accent-rgb), 0.10) !important; }
    `;

    /* ============================================================
       OUR UI CSS
       ============================================================ */

    const UI_CSS = `
        :root {
            --pdl-accent: #21ce99;
            --pdl-accent-rgb: 33, 206, 153;
            --pdl-accent-soft: #7fe3c4;
            --pdl-accent-soft-rgb: 127, 227, 196;
            --pdl-on-accent: #0d0d11;
            --pdl-bg: #16161d;
            --pdl-bg-2: #1c1c24;
            --pdl-bg-3: #101017;
            --pdl-text: #e6e6ec;
            --pdl-muted: rgba(230,230,236,0.56);
            --pdl-faint: rgba(230,230,236,0.36);
            --pdl-border: rgba(255,255,255,0.08);
            --pdl-border-strong: rgba(255,255,255,0.14);
            --pdl-shadow: 0 22px 60px -12px rgba(0,0,0,0.72), 0 0 0 1px rgba(255,255,255,0.02) inset;
            --pdl-font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        /* Native-looking sidebar row */
        #panopto-dl-sidebar-btn {
            display: flex !important;
            align-items: center;
            gap: 6px;
            padding: 4px 6px 3px 14px !important;
            margin: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            box-sizing: border-box !important;
            border: 0 !important;
            border-radius: 0 3px 3px 0 !important;
            cursor: pointer;
            color: rgba(0,0,0,0.8);
            font-family: var(--pdl-font);
            font-size: 12px !important;
            font-weight: 500;
            line-height: 1.35;
            user-select: none;
            overflow: hidden !important;
            flex-shrink: 0 !important;
            transition: background-color .15s, color .15s;
        }
        #panopto-dl-sidebar-btn:hover { background: #e5e5e5; color: #000; }
        body.pdl-dark #panopto-dl-sidebar-btn { color: rgba(230,230,236,0.72); }
        body.pdl-dark #panopto-dl-sidebar-btn:hover { background: rgba(255,255,255,0.06); color: #fff; }
        #panopto-dl-sidebar-btn:focus-visible {
            outline: 2px solid var(--pdl-accent) !important;
            outline-offset: -2px;
        }
        #panopto-dl-sidebar-btn .pdl-sb-text {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 0 1 auto;
        }
        #panopto-dl-sidebar-btn .pdl-sb-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: var(--pdl-accent);
            box-shadow: 0 0 8px rgba(var(--pdl-accent-rgb), .8);
            flex: none; display: none;
            margin-left: auto;
        }
        #panopto-dl-sidebar-btn.pdl-has-active .pdl-sb-dot { display: block; }

        /* Panel */
        #pdl-panel {
            position: fixed;
            top: 11%;
            left: max(12px, calc(50% - 230px));
            width: 460px;
            max-width: calc(100vw - 24px);
            max-height: min(84vh, 780px);
            display: flex;
            flex-direction: column;
            z-index: 2147483647;
            box-sizing: border-box;
            color: var(--pdl-text);
            font-family: var(--pdl-font);
            font-size: 13px;
            line-height: 1.4;
            background:
                radial-gradient(120% 90% at 0% 0%, rgba(var(--pdl-accent-rgb), .10), transparent 55%),
                linear-gradient(180deg, #1e1e26, #15151b);
            border: 1px solid var(--pdl-border-strong);
            border-radius: 12px;
            box-shadow: var(--pdl-shadow);
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
            transform: translateY(-6px) scale(.985);
            transition: opacity .18s ease, transform .18s cubic-bezier(.2,.8,.2,1), visibility .18s;
            overflow: hidden;
        }
        #pdl-panel.pdl-open {
            opacity: 1;
            visibility: visible;
            pointer-events: auto;
            transform: translateY(0) scale(1);
        }
        /* A custom split must win over the table's auto layout, otherwise the
           right pane's minimum content width pins the left column. */
        #viewerContent.pdl-managed { table-layout: fixed !important; }

        #pdl-panel, #pdl-panel *, #pdl-splitter, #pdl-splitter *, #pdl-toasts, #pdl-toasts * {
            box-sizing: border-box;
        }
        #pdl-panel h3, #pdl-panel h4, #pdl-panel p { margin: 0; }
        /* Zero specificity: component classes must be able to set padding,
           colour and background. An ID selector here silently killed them. */
        :where(#pdl-panel button) {
            font: inherit;
            color: inherit;
            border: 0;
            background: none;
            padding: 0;
            cursor: pointer;
        }
        #pdl-panel button:focus-visible,
        #pdl-splitter button:focus-visible {
            outline: 2px solid var(--pdl-accent-soft);
            outline-offset: 2px;
        }
        #pdl-panel .pdl-svg { display: block; }

        #pdl-header {
            flex: none;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 11px 12px 11px 14px;
            border-bottom: 1px solid var(--pdl-border);
            background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.008));
            cursor: grab;
            user-select: none;
        }
        #pdl-header:active { cursor: grabbing; }
        #pdl-title {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            font-size: 13.5px;
            font-weight: 650;
            letter-spacing: .2px;
            color: #fff;
        }
        #pdl-title .pdl-title-ico {
            display: inline-flex;
            color: var(--pdl-accent-soft);
            filter: drop-shadow(0 0 8px rgba(var(--pdl-accent-rgb), .45));
        }
        #pdl-active-pill {
            display: none;
            align-items: center;
            gap: 4px;
            padding: 1px 7px;
            border-radius: 999px;
            background: rgba(var(--pdl-accent-rgb), .14);
            color: var(--pdl-accent-soft);
            border: 1px solid rgba(var(--pdl-accent-rgb), .28);
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .3px;
            font-variant-numeric: tabular-nums;
        }
        #pdl-active-pill.pdl-show { display: inline-flex; }
        #pdl-head-actions { display: flex; align-items: center; gap: 6px; }
        .pdl-head-btn {
            width: 28px; height: 28px;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 7px;
            color: var(--pdl-muted);
            border: 1px solid transparent;
            transition: background .15s, color .15s, border-color .15s;
        }
        .pdl-head-btn:hover {
            background: rgba(255,255,255,.07);
            color: #fff;
            border-color: var(--pdl-border);
        }
        #pdl-close:hover {
            background: rgba(231,76,60,.16);
            border-color: rgba(231,76,60,.35);
            color: #ff8a7c;
        }

        #pdl-tabs {
            flex: none;
            display: flex;
            gap: 4px;
            padding: 10px 12px 0;
            border-bottom: 1px solid var(--pdl-border);
        }
        .pdl-tab {
            flex: 1 1 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 6px 8px 14px;
            border-radius: 8px 8px 0 0;
            color: var(--pdl-muted);
            font-size: 12px;
            font-weight: 600;
            line-height: 1.2;
            letter-spacing: .2px;
            border: 1px solid transparent;
            border-bottom: 0;
            position: relative;
            transition: color .15s, background .15s, border-color .15s;
            white-space: nowrap;
        }
        .pdl-tab .pdl-svg { opacity: .85; }
        .pdl-tab:hover { color: #fff; background: rgba(255,255,255,.045); }
        .pdl-tab[aria-selected="true"] {
            color: var(--pdl-accent-soft);
            background: rgba(var(--pdl-accent-rgb), .09);
            border-color: rgba(var(--pdl-accent-rgb), .22);
        }
        .pdl-tab-underline {
            position: absolute;
            left: 10px;
            right: 10px;
            bottom: 4px;
            height: 2px;
            border-radius: 2px;
            background: transparent;
            pointer-events: none;
        }
        .pdl-tab[aria-selected="true"] .pdl-tab-underline {
            background: var(--pdl-accent);
            box-shadow: 0 0 8px rgba(var(--pdl-accent-rgb), .45);
        }
        .pdl-tab-count {
            display: none;
            min-width: 16px;
            padding: 0 5px;
            border-radius: 999px;
            background: var(--pdl-accent);
            color: var(--pdl-on-accent);
            font-size: 9.5px;
            font-weight: 800;
            line-height: 15px;
            text-align: center;
            font-variant-numeric: tabular-nums;
        }
        .pdl-tab-count.pdl-show { display: inline-block; }

        #pdl-body {
            flex: 1 1 auto;
            min-height: 160px;
            max-height: calc(84vh - 118px);
            overflow-y: auto;
            overscroll-behavior: contain;
            padding: 14px;
            scrollbar-width: thin;
            scrollbar-color: rgba(var(--pdl-accent-rgb), .35) transparent;
        }
        #pdl-body::-webkit-scrollbar { width: 9px; }
        #pdl-body::-webkit-scrollbar-thumb { background: rgba(var(--pdl-accent-rgb), .3); border-radius: 9px; border: 2px solid transparent; background-clip: padding-box; }
        #pdl-body::-webkit-scrollbar-thumb:hover { background: rgba(var(--pdl-accent-rgb), .5); background-clip: padding-box; }

        .pdl-view { display: none; }
        .pdl-view.pdl-active { display: block; animation: pdl-fade .18s ease; }
        @keyframes pdl-fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

        /* Shared bits */
        .pdl-section-title {
            font-size: 10.5px;
            font-weight: 750;
            letter-spacing: .9px;
            text-transform: uppercase;
            color: var(--pdl-faint);
            margin: 2px 0 8px;
        }
        .pdl-muted { color: var(--pdl-muted); }
        .pdl-faint { color: var(--pdl-faint); }
        .pdl-row-between { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .pdl-icon-btn {
            width: 30px; height: 30px;
            flex: none;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 8px;
            color: var(--pdl-muted);
            border: 1px solid var(--pdl-border);
            background: rgba(255,255,255,.035);
            transition: background .15s, color .15s, border-color .15s, transform .1s;
        }
        .pdl-icon-btn:hover { background: rgba(255,255,255,.09); color: #fff; border-color: var(--pdl-border-strong); }
        .pdl-icon-btn:active { transform: scale(.94); }
        .pdl-icon-btn.pdl-danger:hover { background: rgba(231,76,60,.16); color: #ff8a7c; border-color: rgba(231,76,60,.35); }
        .pdl-primary-btn {
            width: 32px; height: 32px;
            flex: none;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 8px;
            background: var(--pdl-accent);
            color: var(--pdl-on-accent);
            border: 1px solid transparent;
            box-shadow: 0 5px 14px -4px rgba(var(--pdl-accent-rgb), .55);
            transition: filter .15s, transform .1s, box-shadow .15s;
        }
        .pdl-primary-btn:hover { filter: brightness(1.08); box-shadow: 0 7px 18px -4px rgba(var(--pdl-accent-rgb), .7); }
        .pdl-primary-btn:active { transform: scale(.94); }
        .pdl-primary-btn:disabled {
            background: rgba(255,255,255,.07);
            color: var(--pdl-faint);
            box-shadow: none;
            cursor: not-allowed;
            filter: none;
            border-color: var(--pdl-border);
        }
        .pdl-text-btn {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 5px 9px;
            border-radius: 7px;
            color: var(--pdl-muted);
            border: 1px solid var(--pdl-border);
            background: rgba(255,255,255,.03);
            font-size: 11px;
            font-weight: 600;
            transition: background .15s, color .15s, border-color .15s;
        }
        .pdl-text-btn:hover { background: rgba(255,255,255,.08); color: #fff; border-color: var(--pdl-border-strong); }
        .pdl-text-btn.pdl-danger:hover { background: rgba(231,76,60,.14); color: #ff8a7c; border-color: rgba(231,76,60,.32); }
        .pdl-text-btn .pdl-svg { opacity: .85; }

        /* Stream picker */
        .pdl-session-head { margin-bottom: 12px; }
        .pdl-session-name {
            font-size: 13px;
            font-weight: 650;
            color: #fff;
            overflow: hidden;
            text-overflow: ellipsis;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            line-height: 1.35;
            word-break: break-word;
        }
        .pdl-session-meta {
            margin-top: 3px;
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
            font-size: 11px;
            color: var(--pdl-muted);
        }
        .pdl-dot-sep { width: 3px; height: 3px; border-radius: 50%; background: var(--pdl-faint); display: inline-block; }
        .pdl-stream {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 11px;
            margin-bottom: 8px;
            border-radius: 9px;
            border: 1px solid var(--pdl-border);
            background: linear-gradient(180deg, rgba(255,255,255,.038), rgba(255,255,255,.014));
            transition: border-color .15s, background .15s, transform .12s;
        }
        .pdl-stream:hover {
            border-color: rgba(var(--pdl-accent-rgb), .28);
            background: linear-gradient(180deg, rgba(var(--pdl-accent-rgb), .055), rgba(255,255,255,.02));
            transform: translateY(-1px);
        }
        .pdl-stream-ico {
            width: 34px; height: 34px;
            flex: none;
            display: flex; align-items: center; justify-content: center;
            border-radius: 8px;
            background: rgba(var(--pdl-accent-rgb), .10);
            color: var(--pdl-accent-soft);
            border: 1px solid rgba(var(--pdl-accent-rgb), .18);
        }
        .pdl-stream-main { flex: 1 1 auto; min-width: 0; }
        .pdl-stream-title {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            font-size: 12.5px;
            font-weight: 650;
            color: #fff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .pdl-stream-sub {
            margin-top: 2px;
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 10.5px;
            color: var(--pdl-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-variant-numeric: tabular-nums;
        }
        .pdl-chip {
            flex: none;
            font-size: 8.5px;
            font-weight: 800;
            letter-spacing: .5px;
            padding: 1px 5px;
            border-radius: 4px;
            color: var(--pdl-accent-soft);
            background: rgba(var(--pdl-accent-rgb), .12);
            border: 1px solid rgba(var(--pdl-accent-rgb), .22);
        }
        .pdl-chip.pdl-chip-warn { color: #f0b45a; background: rgba(240,180,90,.10); border-color: rgba(240,180,90,.25); }
        .pdl-stream-actions { display: flex; align-items: center; gap: 6px; flex: none; }

        .pdl-empty {
            text-align: center;
            padding: 28px 18px;
            color: var(--pdl-muted);
            font-size: 12px;
            line-height: 1.55;
        }
        .pdl-empty .pdl-empty-ico {
            width: 46px; height: 46px;
            margin: 0 auto 10px;
            display: flex; align-items: center; justify-content: center;
            border-radius: 50%;
            color: var(--pdl-faint);
            background: rgba(255,255,255,.04);
            border: 1px solid var(--pdl-border);
        }
        .pdl-empty strong { color: var(--pdl-text); font-weight: 650; }
        .pdl-error-box {
            padding: 12px;
            border-radius: 9px;
            border: 1px solid rgba(231,76,60,.30);
            background: rgba(231,76,60,.09);
            color: #ffb4a9;
            font-size: 12px;
            line-height: 1.5;
            word-break: break-word;
        }
        .pdl-error-box + .pdl-text-btn { margin-top: 10px; }

        .pdl-loading {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 14px 4px;
            color: var(--pdl-muted);
            font-size: 12px;
        }
        .pdl-spinner {
            width: 15px; height: 15px;
            border-radius: 50%;
            border: 2px solid rgba(255,255,255,.14);
            border-top-color: var(--pdl-accent);
            animation: pdl-rotate .8s linear infinite;
            flex: none;
        }
        @keyframes pdl-rotate { to { transform: rotate(360deg); } }

        /* Activity / queue */
        .pdl-summary {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 10px;
            font-size: 11px;
            color: var(--pdl-muted);
        }
        .pdl-summary strong { color: var(--pdl-text); font-weight: 650; }
        .pdl-task {
            position: relative;
            padding: 10px 11px;
            border-radius: 9px;
            border: 1px solid var(--pdl-border);
            background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012));
            margin-bottom: 8px;
        }
        .pdl-task[data-state="downloading"] { border-color: rgba(var(--pdl-accent-rgb), .20); }
        .pdl-task[data-state="complete"] { opacity: .82; }
        .pdl-task[data-state="error"],
        .pdl-task[data-state="interrupted"] { border-color: rgba(231,76,60,.20); }
        .pdl-task-head { display: flex; align-items: flex-start; gap: 8px; }
        .pdl-task-ico {
            width: 26px; height: 26px;
            flex: none;
            border-radius: 7px;
            display: flex; align-items: center; justify-content: center;
            color: var(--pdl-accent-soft);
            background: rgba(var(--pdl-accent-rgb), .09);
            margin-top: 1px;
        }
        .pdl-task[data-state="complete"] .pdl-task-ico { color: #67d99a; background: rgba(103,217,154,.10); }
        .pdl-task[data-state="error"] .pdl-task-ico,
        .pdl-task[data-state="interrupted"] .pdl-task-ico { color: #ff8a7c; background: rgba(231,76,60,.10); }
        .pdl-task-main { flex: 1 1 auto; min-width: 0; }
        .pdl-task-title {
            font-size: 12px;
            font-weight: 600;
            color: #fff;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .pdl-task-sub {
            margin-top: 2px;
            font-size: 10.5px;
            line-height: 1.4;
            color: var(--pdl-muted);
            display: flex;
            align-items: center;
            gap: 5px;
            flex-wrap: wrap;
            font-variant-numeric: tabular-nums;
        }
        .pdl-task-state { font-weight: 650; }
        .pdl-task-state.pdl-state-ok { color: var(--pdl-accent-soft); }
        .pdl-task-state.pdl-state-done { color: #67d99a; }
        .pdl-task-state.pdl-state-err { color: #ff8a7c; }
        .pdl-task-actions { display: flex; align-items: center; gap: 4px; flex: none; }
        .pdl-mini-btn {
            width: 24px; height: 24px;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 6px;
            color: var(--pdl-faint);
            transition: background .15s, color .15s;
        }
        .pdl-mini-btn:hover { background: rgba(255,255,255,.08); color: #fff; }
        .pdl-mini-btn.pdl-danger:hover { background: rgba(231,76,60,.16); color: #ff8a7c; }
        .pdl-task-bar-wrap {
            margin-top: 11px;
            height: 4px;
            border-radius: 99px;
            background: rgba(255,255,255,.07);
            overflow: hidden;
        }
        .pdl-task-bar {
            height: 100%;
            width: 0%;
            border-radius: 99px;
            background: var(--pdl-accent);
            box-shadow: 0 0 8px rgba(var(--pdl-accent-rgb), .55);
            transition: width .18s linear;
        }
        .pdl-task-bar.pdl-indeterminate {
            width: 35% !important;
            animation: pdl-indet 1.15s ease-in-out infinite;
        }
        @keyframes pdl-indet {
            0% { transform: translateX(-110%); }
            100% { transform: translateX(320%); }
        }
        .pdl-task-bar.pdl-bar-done { background: #55cc8a; box-shadow: 0 0 8px rgba(85,204,138,.35); }
        .pdl-task-bar.pdl-bar-err { background: #e05a4c; box-shadow: none; }
        .pdl-task-foot {
            margin-top: 7px;
            display: flex;
            justify-content: space-between;
            gap: 8px;
            font-size: 10px;
            color: var(--pdl-faint);
            font-variant-numeric: tabular-nums;
        }
        .pdl-task-error {
            margin-top: 6px;
            font-size: 10.5px;
            color: #ff9c90;
            word-break: break-word;
        }

        /* Layout view */
        .pdl-layout-intro {
            font-size: 11.5px;
            color: var(--pdl-muted);
            line-height: 1.5;
            margin-bottom: 12px;
        }
        .pdl-layout-intro kbd {
            font-family: inherit;
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 4px;
            border: 1px solid var(--pdl-border-strong);
            background: rgba(255,255,255,.05);
            color: var(--pdl-text);
        }
        .pdl-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            padding: 10px 0;
            border-bottom: 1px solid var(--pdl-border);
        }
        .pdl-row:last-child { border-bottom: 0; }
        .pdl-row-label { min-width: 0; }
        .pdl-row-label strong {
            display: block;
            font-size: 12px;
            font-weight: 600;
            color: var(--pdl-text);
        }
        .pdl-row-label span {
            display: block;
            margin-top: 1px;
            font-size: 10.5px;
            color: var(--pdl-muted);
            line-height: 1.4;
        }
        .pdl-switch { position: relative; width: 34px; height: 20px; flex: none; }
        .pdl-switch input {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            margin: 0;
            opacity: 0;
            cursor: pointer;
            z-index: 1;
        }
        .pdl-switch span {
            position: absolute;
            inset: 0;
            border-radius: 999px;
            background: rgba(255,255,255,.12);
            transition: background .15s;
        }
        .pdl-switch span::after {
            content: "";
            position: absolute;
            top: 3px; left: 3px;
            width: 14px; height: 14px;
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 1px 3px rgba(0,0,0,.35);
            transition: transform .15s;
        }
        .pdl-switch input:checked + span { background: var(--pdl-accent); }
        .pdl-switch input:checked + span::after { transform: translateX(14px); }
        .pdl-switch input:disabled + span { opacity: .4; cursor: not-allowed; }
        .pdl-switch input:focus-visible + span { outline: 2px solid var(--pdl-accent-soft); outline-offset: 2px; }

        .pdl-split-control {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 4px;
        }
        .pdl-range {
            -webkit-appearance: none;
            appearance: none;
            flex: 1 1 auto;
            height: 22px;
            background: transparent;
            outline: none;
            margin: 0;
            cursor: pointer;
        }
        .pdl-range::-moz-range-track {
            height: 4px;
            border-radius: 99px;
            background: rgba(255,255,255,.16);
        }
        .pdl-range::-moz-range-progress {
            height: 4px;
            border-radius: 99px;
            background: var(--pdl-accent);
        }
        .pdl-range::-webkit-slider-runnable-track {
            height: 4px;
            border-radius: 99px;
            background: rgba(255,255,255,.16);
        }
        .pdl-range::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px; height: 14px;
            margin-top: -5px;
            border-radius: 50%;
            background: var(--pdl-accent);
            border: 2px solid #16161d;
            box-shadow: 0 0 0 1px rgba(var(--pdl-accent-rgb), .5);
        }
        .pdl-range::-moz-range-thumb {
            width: 14px; height: 14px;
            border-radius: 50%;
            background: var(--pdl-accent);
            border: 2px solid #16161d;
            box-shadow: 0 0 0 1px rgba(var(--pdl-accent-rgb), .5);
        }
        .pdl-range:disabled { opacity: .4; cursor: not-allowed; }
        .pdl-range-val {
            width: 36px;
            text-align: right;
            font-size: 10.5px;
            color: var(--pdl-muted);
            font-variant-numeric: tabular-nums;
            flex: none;
        }

        /* Toasts */
        #pdl-toasts {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 8px;
            pointer-events: none;
            font-family: var(--pdl-font);
        }
        .pdl-toast {
            max-width: min(360px, calc(100vw - 32px));
            padding: 9px 12px;
            border-radius: 9px;
            background: rgba(26,26,33,.97);
            border: 1px solid var(--pdl-border-strong);
            color: var(--pdl-text);
            font-size: 11.5px;
            line-height: 1.4;
            box-shadow: 0 12px 30px rgba(0,0,0,.5);
            animation: pdl-toast-in .18s ease;
            word-break: break-word;
        }
        .pdl-toast-success { border-color: rgba(var(--pdl-accent-rgb), .35); color: var(--pdl-accent-soft); }
        .pdl-toast-error { border-color: rgba(231,76,60,.4); color: #ff9c90; }
        .pdl-toast-out { opacity: 0; transform: translateY(4px); transition: opacity .2s, transform .2s; }
        @keyframes pdl-toast-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

        /* Splitter */
        #pdl-splitter {
            position: fixed;
            z-index: 2147483600;
            display: none;
            width: 14px;
            margin-left: 0;
            cursor: col-resize;
            touch-action: none;
        }
        #pdl-splitter.pdl-split-visible { display: flex; }
        #pdl-splitter.pdl-split-horizontal {
            width: auto;
            height: 14px;
            margin-left: 0;
            margin-top: 0;
            cursor: row-resize;
        }
        #pdl-splitter .pdl-split-line {
            position: absolute;
            left: 6px;
            top: 0;
            bottom: 0;
            width: 2px;
            background: rgba(255,255,255,.14);
            transition: background .15s, box-shadow .15s;
        }
        #pdl-splitter.pdl-split-horizontal .pdl-split-line {
            left: 0; right: 0; top: 6px; bottom: auto; width: auto; height: 2px;
        }
        #pdl-splitter:hover .pdl-split-line,
        #pdl-splitter:focus-visible .pdl-split-line,
        #pdl-splitter.pdl-split-dragging .pdl-split-line {
            background: var(--pdl-accent);
            box-shadow: 0 0 10px rgba(var(--pdl-accent-rgb), .7);
        }
        #pdl-splitter .pdl-split-grip {
            position: absolute;
            left: calc(50% + 12px);
            top: 50%;
            transform: translate(-50%, -50%);
            width: 14px;
            height: 40px;
            border-radius: 7px;
            background: rgba(22,22,29,.96);
            border: 1px solid var(--pdl-border-strong);
            color: var(--pdl-muted);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity .15s;
            pointer-events: none;
            box-shadow: 0 3px 10px rgba(0,0,0,.35);
        }
        #pdl-splitter.pdl-split-horizontal .pdl-split-grip {
            width: 40px;
            height: 14px;
            left: 50%;
            top: calc(50% + 12px);
        }
        #pdl-splitter.pdl-split-horizontal .pdl-split-collapse {
            left: 50%;
            top: calc(50% + 14px);
            transform: translate(-50%, 0);
        }
        #pdl-splitter:hover .pdl-split-grip,
        #pdl-splitter:focus-visible .pdl-split-grip,
        #pdl-splitter.pdl-split-dragging .pdl-split-grip { opacity: 1; }
        #pdl-splitter .pdl-split-collapse {
            position: absolute;
            left: calc(50% + 14px);
            top: 12px;
            transform: translate(-50%, 0);
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            background: rgba(22,22,29,.97);
            border: 1px solid var(--pdl-border-strong);
            color: var(--pdl-muted);
            opacity: 0;
            pointer-events: none;
            transition: opacity .15s, background .15s, color .15s;
            box-shadow: 0 3px 10px rgba(0,0,0,.4);
        }
        #pdl-splitter:hover .pdl-split-collapse,
        #pdl-splitter:focus-within .pdl-split-collapse {
            opacity: 1;
            pointer-events: auto;
        }
        #pdl-splitter .pdl-split-collapse:hover {
            background: var(--pdl-accent);
            color: var(--pdl-on-accent);
            border-color: transparent;
        }
        #pdl-splitter.pdl-split-collapsed {
            width: 26px;
            margin-left: 0;
            cursor: pointer;
        }
        #pdl-splitter.pdl-split-collapsed .pdl-split-line,
        #pdl-splitter.pdl-split-collapsed .pdl-split-grip { display: none; }
        #pdl-splitter.pdl-split-collapsed .pdl-split-collapse {
            opacity: 1;
            pointer-events: auto;
            top: 50%;
            transform: translate(0, -50%);
            left: 0;
            width: 22px;
            height: 44px;
            border-radius: 0 9px 9px 0;
        }

        body.pdl-resizing, body.pdl-resizing * {
            cursor: col-resize !important;
            user-select: none !important;
        }
        body.pdl-resizing.pdl-resizing-row, body.pdl-resizing.pdl-resizing-row * {
            cursor: row-resize !important;
        }

        @media (max-width: 520px) {
            #pdl-panel { left: 8px; width: calc(100vw - 16px); top: 8px; max-height: calc(100vh - 16px); }
            #pdl-body { max-height: calc(100vh - 130px); }
        }
        @media (prefers-reduced-motion: reduce) {
            #pdl-panel, .pdl-view.pdl-active, .pdl-toast, .pdl-task-bar { animation: none !important; transition: none !important; }
        }
    `;

    /* ============================================================
       PLAYER GUARD
       Keeps Panopto's two <video> elements behaving like one player.
       ============================================================ */

    const Player = (() => {
        let intent = 'paused';
        let syncing = false;
        let lastActive = null;
        let playRetryTimer = 0;

        function mainVideos() {
            const out = [];
            const ids = ['secondaryVideo', 'primaryVideo'];
            for (const id of ids) {
                const v = document.getElementById(id);
                if (v && v.tagName === 'VIDEO') out.push(v);
            }
            if (!out.length) {
                $$('#viewerContent video, #rightPlayersContainer video, #leftPlayerContainer video').forEach(v => {
                    if (!out.includes(v)) out.push(v);
                });
            }
            return out;
        }

        function hasAudio(v) {
            try {
                if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
                if (v.audioTracks && typeof v.audioTracks.length === 'number') return v.audioTracks.length > 0;
                if (typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount > 0) return true;
            } catch (e) { /* ignore */ }
            return null;
        }

        function safePlay(v) {
            if (!v || v.tagName !== 'VIDEO') return;
            try {
                const p = v.play();
                if (p && typeof p.catch === 'function') {
                    p.catch(err => {
                        if (!err) return;
                        if (err.name === 'AbortError') {
                            clearTimeout(playRetryTimer);
                            playRetryTimer = setTimeout(() => {
                                if (intent === 'playing' && v.paused) safePlay(v);
                            }, 140);
                        }
                        // NotAllowedError: wait for the user's next click/keypress.
                    });
                }
            } catch (e) { /* ignore */ }
        }

        function playAll() {
            intent = 'playing';
            for (const v of mainVideos()) {
                if (v.readyState === 0) {
                    v.addEventListener('canplay', () => {
                        if (intent === 'playing' && v.paused) safePlay(v);
                    }, { once: true });
                } else {
                    safePlay(v);
                }
            }
            registerMediaSession();
        }

        function pauseAll() {
            intent = 'paused';
            for (const v of mainVideos()) {
                try { v.pause(); } catch (e) { /* ignore */ }
            }
        }

        function toggle() {
            const anyPlaying = mainVideos().some(v => !v.paused);
            if (anyPlaying) pauseAll(); else playAll();
        }

        function syncTime(from) {
            if (syncing) return;
            if (!from || !isFinite(from.currentTime)) return;
            syncing = true;
            for (const v of mainVideos()) {
                if (v === from || v.readyState < 1) continue;
                if (Math.abs(v.currentTime - from.currentTime) > 1.1) {
                    try { v.currentTime = from.currentTime; } catch (e) { /* ignore */ }
                }
            }
            setTimeout(() => { syncing = false; }, 120);
        }

        function registerMediaSession() {
            if (!('mediaSession' in navigator) || !navigator.mediaSession) return;
            const set = (action, fn) => {
                try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* unsupported */ }
            };
            set('play', playAll);
            set('pause', pauseAll);
            set('playpause', toggle);
        }

        function onPlay(e) {
            const v = e.target;
            if (!v || v.tagName !== 'VIDEO') return;
            if (!mainVideos().includes(v)) return;
            lastActive = v;
            intent = 'playing';
            if (syncing) return;
            syncing = true;
            for (const other of mainVideos()) {
                if (other === v) continue;
                if (other.paused && other.readyState >= 1) safePlay(other);
            }
            setTimeout(() => { syncing = false; }, 220);
            if (isFinite(v.currentTime)) syncTime(v);
            registerMediaSession();
        }

        function onPause(e) {
            const v = e.target;
            if (!v || v.tagName !== 'VIDEO') return;
            if (!mainVideos().includes(v)) return;
            intent = 'paused';
            if (syncing) return;
            syncing = true;
            for (const other of mainVideos()) {
                if (other === v) continue;
                if (!other.paused) {
                    try { other.pause(); } catch (err) { /* ignore */ }
                }
            }
            setTimeout(() => { syncing = false; }, 220);
        }

        function onSeeked(e) {
            const v = e.target;
            if (!v || v.tagName !== 'VIDEO') return;
            if (!mainVideos().includes(v)) return;
            if (!v.paused) syncTime(v);
        }

        function init() {
            // Capture phase: play/pause do not bubble, but they do capture.
            document.addEventListener('play', onPlay, true);
            document.addEventListener('pause', onPause, true);
            document.addEventListener('seeked', onSeeked, true);
            document.addEventListener('ended', () => { intent = 'paused'; }, true);

            // Panopto sometimes stops Space at a control. Always control the real player.
            document.addEventListener('keydown', (e) => {
                if (e.key !== ' ' && e.code !== 'Space') return;
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                const t = e.target;
                if (isEditable(t)) return;
                if (t && t.closest && t.closest('[role="button"], button, a, [role="menu"], [role="menuitem"], [role="menuitemradio"]')) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                toggle();
            }, true);

            // Some controls swallow Space and let the page scroll instead.
            document.addEventListener('keyup', (e) => {
                if (e.key !== ' ' && e.code !== 'Space') return;
                if (isEditable(e.target)) return;
                if (e.defaultPrevented) return;
            }, true);

            // Resume after the tab is backgrounded or restored from bfcache.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && intent === 'playing') {
                    playAll();
                }
            });
            window.addEventListener('focus', () => {
                if (intent === 'playing') {
                    const vids = mainVideos();
                    if (vids.length && vids.every(v => v.paused)) playAll();
                }
            });
            window.addEventListener('pageshow', () => {
                if (intent === 'playing') playAll();
            });

            // Panopto may register its Media Session handlers after us.
            let tries = 0;
            const timer = setInterval(() => {
                registerMediaSession();
                if (++tries > 8) clearInterval(timer);
            }, 1500);
            registerMediaSession();

            // Audio sanity: if one stream is silent, leaving it unmuted is harmless;
            // if both are audible, avoid double audio by muting the non-audio stream.
            document.addEventListener('volumechange', (e) => {
                const v = e.target;
                if (!v || v.tagName !== 'VIDEO') return;
                if (!mainVideos().includes(v)) return;
            }, true);
        }

        return { init, playAll, pauseAll, toggle, mainVideos, hasAudio };
    })();

    /* ============================================================
       LAYOUT MANAGER
       Resizes the camera/sidebar column vs the slides column.
       ============================================================ */

    const Layout = (() => {
        const DEFAULTS = { ratio: null, camera: true, slides: true, collapsed: false };
        let state = Object.assign({}, DEFAULTS, store.get(K.layout, {}));
        if (typeof state.ratio === 'number') state.ratio = clamp(state.ratio, 0.16, 0.72);

        let parts = null;
        let origStyles = null;
        let observer = null;
        let applyTimer = 0;
        let applying = false;
        let handle = null;
        let handleRaf = 0;
        let lastGeometry = null;
        let suppressUntil = 0;
        let paneRO = null;
        let paneMO = null;
        let paneSyncRaf = 0;
        let aspectCache = new WeakMap();
        let onChange = null;

        function save() {
            store.set(K.layout, state);
        }

        function findParts() {
            const viewer = document.getElementById('viewerContent');
            const leftPane = document.getElementById('leftPane');
            if (!viewer || !leftPane) return null;
            if (viewer.getBoundingClientRect().width < 80) return null;

            const leftPlayer = document.getElementById('leftPlayerContainer');
            const primaryPlayer = document.getElementById('primaryPlayer');
            const primaryScreen = document.getElementById('primaryScreen');
            const aside = leftPane.querySelector('aside[role="complementary"]') || leftPane.querySelector('aside');
            const eventTabs = document.getElementById('eventTabs');
            const eventTabPanes = document.getElementById('eventTabPanes');
            const eventTabControl = document.getElementById('eventTabControl');
            const searchRegion = document.getElementById('searchRegion');
            const rightPane = document.getElementById('rightPane');
            const rightPlayers = document.getElementById('rightPlayersContainer');
            const secondaryScreen = document.getElementById('secondaryScreen');
            const playControls = document.getElementById('playControlsWrapper');
            const thumbs = document.getElementById('thumbnailList');

            let main = leftPane.parentElement ? Array.prototype.find.call(leftPane.parentElement.children, el => el.tagName === 'MAIN') : null;
            if (!main) main = document.querySelector('main');
            if (!main || !rightPane || !rightPlayers) return null;

            const secondaryWrapper = rightPlayers.querySelector('.secondaryPlayer');
            const secondaryContent = secondaryWrapper ? secondaryWrapper.querySelector('.secondary-content') : null;
            // A slides-only / camera-only recording has a single player and no
            // secondary wrapper. Panopto's native layout already puts it in the
            // right pane; the two-stream split must not touch it.
            // The wrapper can exist as an empty placeholder; the video is the
            // definitive signal for a real second stream.
            const singleStream = !document.getElementById('secondaryVideo');
            return {
                viewer, leftPane, leftPlayer, primaryPlayer, primaryScreen, aside,
                eventTabs, eventTabPanes, eventTabControl, searchRegion,
                main, rightPane, rightPlayers, secondaryScreen, playControls, thumbs,
                secondaryWrapper, secondaryContent, singleStream,
                roaming: document.querySelector('.secondaryPlayer.player.roaming')
            };
        }

        function snapshot() {
            if (!parts) return;
            origStyles = new Map();
            [
                parts.leftPane, parts.leftPlayer, parts.primaryPlayer, parts.primaryScreen,
                parts.eventTabs, parts.eventTabPanes, parts.main, parts.rightPlayers,
                parts.secondaryScreen, parts.thumbs
            ].forEach(el => {
                if (el) origStyles.set(el, el.getAttribute('style') || '');
            });
            [parts.primaryScreen, parts.secondaryScreen].forEach(screen => {
                if (!screen) return;
                const r = screen.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) aspectCache.set(screen, r.width / r.height);
            });
        }

        function restore() {
            if (!origStyles) return;
            for (const [el, style] of origStyles) {
                if (!el || !el.isConnected) continue;
                if (style) el.setAttribute('style', style);
                else el.removeAttribute('style');
            }
            document.body.classList.remove('pdl-no-camera', 'pdl-no-slides', 'pdl-left-collapsed');
        }

        function aspectOf(screen) {
            if (!screen) return 16 / 9;
            const video = screen.querySelector('video');
            if (video && video.videoWidth && video.videoHeight) {
                return video.videoWidth / video.videoHeight;
            }
            if (aspectCache.has(screen)) return aspectCache.get(screen);
            const r = screen.getBoundingClientRect();
            const a = r.width && r.height ? r.width / r.height : 16 / 9;
            aspectCache.set(screen, a);
            return a;
        }

        function fitScreen(screen, w, h) {
            if (!screen || !w || !h) return;
            const ar = aspectOf(screen) || 16 / 9;
            let sw = w;
            let sh = w / ar;
            if (sh > h) {
                sh = h;
                sw = h * ar;
            }
            screen.style.left = '50%';
            screen.style.top = '50%';
            screen.style.width = Math.max(1, Math.round(sw)) + 'px';
            screen.style.height = Math.max(1, Math.round(sh)) + 'px';
            screen.style.marginLeft = Math.round(-sw / 2) + 'px';
            screen.style.marginTop = Math.round(-sh / 2) + 'px';
        }

        function geometrySnapshot() {
            if (!parts) return null;
            const r = (el) => el ? el.getBoundingClientRect() : null;
            const l = r(parts.leftPane), v = r(parts.viewer), rp = r(parts.rightPlayers), et = r(parts.eventTabs), ep = r(parts.eventTabPanes);
            return {
                lw: l ? l.width : 0, lh: l ? l.height : 0,
                vw: v ? v.width : 0, vh: v ? v.height : 0,
                rw: rp ? rp.width : 0, rh: rp ? rp.height : 0,
                tw: et ? et.width : 0, th: et ? et.height : 0,
                pw: ep ? ep.width : 0
            };
        }

        function geometryClose(a, b, tolerance) {
            if (!a || !b) return false;
            return Object.keys(a).every(k => Math.abs((a[k] || 0) - (b[k] || 0)) <= tolerance);
        }

        function apply() {
            if (window.__PDL_HARNESS__) window.__PDL_APPLY_COUNT__ = (window.__PDL_APPLY_COUNT__ || 0) + 1;
            parts = parts || findParts();
            if (!parts) return false;

            // Panopto may create the second player after the first findParts().
            // Refresh when the single/multi verdict no longer matches the DOM.
            const hasSecond = !!document.getElementById('secondaryVideo');
            if (parts.singleStream === hasSecond) {
                parts = findParts();
                if (!parts) return false;
            }

            if (parts.singleStream) {
                // One player: resizing it as the camera covers the sidebar with
                // the player's black background. Keep Panopto's own layout.
                if (origStyles) restore();
                parts.viewer.classList.remove('pdl-managed');
                document.body.classList.remove('pdl-managed', 'pdl-no-camera', 'pdl-no-slides', 'pdl-left-collapsed');
                if (handle) handle.style.display = 'none';
                scheduleHandle();
                return false;
            }
            if (handle) handle.style.display = '';

            if (!origStyles) snapshot();

            applying = true;
            const p = parts;
            const vr = p.viewer.getBoundingClientRect();
            const W = Math.max(200, Math.round(vr.width));
            const H = Math.max(140, Math.round(vr.height));

            const searchH = (p.searchRegion && isVisible(p.searchRegion)) ? Math.round(p.searchRegion.getBoundingClientRect().height) : 0;
            const tabControlW = p.eventTabControl ? Math.round(p.eventTabControl.getBoundingClientRect().width) + 6 : 115;

            document.body.classList.toggle('pdl-no-camera', !state.camera);
            document.body.classList.toggle('pdl-no-slides', !state.slides);
            document.body.classList.toggle('pdl-left-collapsed', !!state.collapsed);
            // A custom split needs fixed table layout, otherwise the right
            // pane's content min-width pins the left column and it cannot grow.
            const managed = typeof state.ratio === 'number' || !state.camera || !state.slides || state.collapsed;
            p.viewer.classList.toggle('pdl-managed', managed);
            document.body.classList.toggle('pdl-managed', managed);

            if (state.collapsed) {
                p.leftPane.style.display = 'none';
                p.main.style.display = '';
                p.main.style.width = '100%';
                p.rightPane.style.width = '100%';
                const rw = Math.max(200, p.viewer.clientWidth || W);
                const rh = Math.max(100, p.rightPlayers.clientHeight || (H - 44));
                p.rightPlayers.style.width = rw + 'px';
                if (p.secondaryWrapper) {
                    p.secondaryWrapper.style.width = rw + 'px';
                    p.secondaryWrapper.style.height = rh + 'px';
                    p.secondaryWrapper.style.margin = '0';
                }
                if (p.secondaryContent) {
                    p.secondaryContent.style.width = '100%';
                    p.secondaryContent.style.height = '100%';
                    p.secondaryContent.style.margin = '0';
                }
                fitScreen(p.secondaryScreen, rw, rh);
            } else {
                p.leftPane.style.display = '';
                p.main.style.width = '';
                p.main.style.display = state.slides ? '' : 'none';

                let targetW;
                if (!state.slides) {
                    targetW = W;
                } else if (typeof state.ratio === 'number') {
                    targetW = Math.round(W * state.ratio);
                } else {
                    const current = p.leftPane.getBoundingClientRect().width;
                    targetW = current > 80 ? Math.round(current) : Math.round(W * 0.42);
                }
                targetW = state.slides ? clamp(targetW, 220, Math.max(240, W - 260)) : W;
                p.leftPane.style.width = targetW + 'px';
                p.leftPane.style.maxWidth = targetW + 'px';
                p.main.style.width = state.slides ? Math.max(0, W - targetW) + 'px' : '';
                p.main.style.minWidth = '0';
                p.rightPane.style.width = '100%';
                p.rightPane.style.minWidth = '0';

                let camH = 0;
                if (state.camera && p.leftPlayer) {
                    p.leftPlayer.style.display = '';
                    p.leftPlayer.style.width = '100%';
                    p.primaryPlayer.style.width = '100%';
                    p.primaryPlayer.style.height = '100%';
                    const lw = Math.max(120, p.leftPlayer.getBoundingClientRect().width || (targetW - 4));
                    camH = Math.round(lw / (aspectOf(p.primaryScreen) || 16 / 9));
                    camH = clamp(camH, 90, Math.round(H * 0.64));
                    p.leftPlayer.style.height = camH + 'px';
                    fitScreen(p.primaryScreen, lw, camH);
                } else if (p.leftPlayer) {
                    p.leftPlayer.style.display = 'none';
                }

                if (p.eventTabs) {
                    const tabsH = Math.max(76, H - camH - searchH);
                    p.eventTabs.style.height = tabsH + 'px';
                    p.eventTabs.style.minHeight = '0';
                }
                if (p.aside) {
                    // The aside must shrink when the camera grows, otherwise its
                    // stale height pushes the tab content under the player and
                    // the bottom items become unreachable.
                    p.aside.style.height = Math.max(0, H - camH) + 'px';
                    p.aside.style.minHeight = '0';
                    p.aside.style.overflow = 'hidden';
                }
                if (p.eventTabPanes) {
                    const panesW = Math.max(60, Math.round((p.leftPane.getBoundingClientRect().width || targetW) - tabControlW));
                    p.eventTabPanes.style.width = panesW + 'px';
                    p.eventTabPanes.style.overflow = 'hidden';
                    p.eventTabPanes.querySelectorAll('.event-tab-pane').forEach(pane => {
                        pane.style.width = panesW + 'px';
                    });
                }

                if (state.slides && p.rightPlayers) {
                    // When Panopto floats the secondary player out (roaming), it owns
                    // that element's geometry; resizing it would fight the player.
                    if (p.roaming) {
                        if (p.thumbs && isVisible(p.thumbs)) p.thumbs.style.width = '';
                    } else {
                        const rw = Math.max(180, Math.round(p.rightPane.getBoundingClientRect().width || (W - targetW)));
                        const rh = Math.max(100, p.rightPlayers.clientHeight || (H - 44));
                        p.rightPlayers.style.width = rw + 'px';
                        if (p.secondaryWrapper) {
                            p.secondaryWrapper.style.width = rw + 'px';
                            p.secondaryWrapper.style.height = rh + 'px';
                            p.secondaryWrapper.style.margin = '0';
                        }
                        if (p.secondaryContent) {
                            p.secondaryContent.style.width = '100%';
                            p.secondaryContent.style.height = '100%';
                            p.secondaryContent.style.margin = '0';
                        }
                        fitScreen(p.secondaryScreen, rw, rh);
                        if (p.thumbs && isVisible(p.thumbs)) p.thumbs.style.width = rw + 'px';
                    }
                }
            }

            lastGeometry = geometrySnapshot();
            // Drop the style mutations we just caused so the observer doesn't loop.
            if (observer) observer.takeRecords();
            applying = false;

            scheduleHandle();
            if (onChange) onChange();
            return true;
        }

        function syncPaneWidths() {
            if (!parts || !parts.eventTabPanes) return;
            const lpW = parts.leftPane.getBoundingClientRect().width || 0;
            if (lpW < 80) return;
            const tabControlW = parts.eventTabControl ? Math.round(parts.eventTabControl.getBoundingClientRect().width) + 6 : 115;
            const panesW = Math.max(60, Math.round(lpW - tabControlW));
            const target = panesW + 'px';
            let applied = false;
            if (parts.eventTabPanes.style.width !== target) {
                parts.eventTabPanes.style.width = target;
                applied = true;
            }
            if (parts.eventTabPanes.style.overflow !== 'hidden') parts.eventTabPanes.style.overflow = 'hidden';
            parts.eventTabPanes.querySelectorAll('.event-tab-pane').forEach(pane => {
                if (pane.style.width !== target) {
                    pane.style.width = target;
                    applied = true;
                }
            });
            if (window.__PDL_HARNESS__) {
                window.__PDL_PANE_SYNC__ = { lpW: Math.round(lpW), tabControlW, panesW, applied };
            }
        }

        // Panopto writes its own inline widths back when tabs switch, and the
        // active pane then sits in a narrower box than the sidebar. Watch both
        // columns and keep the pane container matched, without a full apply.
        function schedulePaneSync() {
            if (paneSyncRaf) return;
            paneSyncRaf = requestAnimationFrame(() => {
                paneSyncRaf = 0;
                syncPaneWidths();
            });
        }

        function watchPaneWidths() {
            if (!parts || !parts.eventTabPanes) return;
            try { if (paneRO) paneRO.disconnect(); } catch (e) { /* ignore */ }
            try { if (paneMO) paneMO.disconnect(); } catch (e) { /* ignore */ }
            paneRO = null;
            paneMO = null;
            if (window.ResizeObserver) {
                paneRO = new ResizeObserver(schedulePaneSync);
                try {
                    paneRO.observe(parts.leftPane);
                    paneRO.observe(parts.eventTabPanes);
                    parts.eventTabPanes.querySelectorAll('.event-tab-pane').forEach(p => paneRO.observe(p));
                } catch (e) { /* ignore */ }
            }
            paneMO = new MutationObserver(schedulePaneSync);
            try {
                paneMO.observe(parts.eventTabPanes, { childList: true, attributes: true, attributeFilter: ['style'] });
                parts.eventTabPanes.querySelectorAll('.event-tab-pane').forEach(p => paneMO.observe(p, { attributes: true, attributeFilter: ['style'] }));
            } catch (e) { /* ignore */ }
        }

        function scheduleApply(delay) {
            clearTimeout(applyTimer);
            applyTimer = setTimeout(() => {
                apply();
            }, delay || 80);
        }

        function startObserver() {
            if (observer || !parts) return;
            observer = new MutationObserver(() => {
                if (applying) return;
                if (typeof state.ratio !== 'number' && state.camera && state.slides && !state.collapsed) {
                    scheduleHandle();
                    return;
                }
                // Switching Panopto tabs is not a layout change. Re-applying
                // here made the whole viewer flicker on every click.
                if (Date.now() < suppressUntil) {
                    scheduleHandle();
                    return;
                }
                // Panopto toggles tabs by changing styles inside the pane. That
                // is not a layout change; re-applying made the whole viewer
                // flicker on every tab switch.
                const g = geometrySnapshot();
                if (lastGeometry && g && geometryClose(g, lastGeometry, 2)) {
                    scheduleHandle();
                    return;
                }
                scheduleApply(100);
            });
            [parts.leftPane, parts.leftPlayer, parts.eventTabs, parts.eventTabPanes, parts.rightPlayers, parts.main].forEach(el => {
                if (el) observer.observe(el, { attributes: true, attributeFilter: ['style'] });
            });
        }

        function updateHandle() {
            if (!handle) return;
            if (!parts) parts = findParts();
            if (!parts) { handle.className = ''; handle.style.display = 'none'; return; }
            if (parts.singleStream) { handle.className = ''; handle.style.display = 'none'; return; }

            if (state.collapsed) {
                const vr = parts.viewer.getBoundingClientRect();
                if (vr.width < 80) { handle.style.display = 'none'; return; }
                handle.className = 'pdl-split-visible pdl-split-collapsed';
                handle.style.display = 'flex';
                handle.style.left = Math.round(vr.left) + 'px';
                handle.style.top = Math.round(vr.top + vr.height / 2 - 22) + 'px';
                handle.style.height = '44px';
                handle.style.width = '22px';
                return;
            }

            if (!state.slides) {
                handle.style.display = 'none';
                return;
            }

            const lr = parts.leftPane.getBoundingClientRect();
            const mr = parts.main.getBoundingClientRect();
            if (lr.width < 40 || mr.width < 40) { handle.style.display = 'none'; return; }

            const sideBySide = lr.left < mr.left;
            handle.style.display = 'flex';
            if (sideBySide) {
                handle.className = 'pdl-split-visible';
                // Sit in the gutter to the right of the boundary. Centring the
                // 14px handle on the boundary put half of it over the tab text.
                handle.style.left = Math.round(lr.right - 7) + 'px';
                handle.style.top = Math.round(lr.top) + 'px';
                handle.style.height = Math.round(lr.height) + 'px';
                handle.style.width = '14px';
            } else {
                handle.className = 'pdl-split-visible pdl-split-horizontal';
                handle.style.top = Math.round(lr.bottom - 7) + 'px';
                handle.style.left = Math.round(lr.left) + 'px';
                handle.style.height = '14px';
                handle.style.width = Math.round(lr.width) + 'px';
            }
        }

        function scheduleHandle() {
            if (handleRaf) return;
            handleRaf = requestAnimationFrame(() => {
                handleRaf = 0;
                updateHandle();
            });
        }

        function setRatio(ratio) {
            state.ratio = clamp(ratio, 0.16, 0.72);
            state.slides = true;
            save();
            apply();
            if (onChange) onChange();
        }

        function setCamera(on) {
            state.camera = !!on;
            if (!state.camera && !state.slides) state.slides = true;
            save();
            apply();
            dispatchResize();
            if (onChange) onChange();
        }

        function setSlides(on) {
            state.slides = !!on;
            if (!state.slides && !state.camera) state.camera = true;
            save();
            apply();
            dispatchResize();
            if (onChange) onChange();
        }

        function setCollapsed(on) {
            state.collapsed = !!on;
            save();
            apply();
            dispatchResize();
            if (onChange) onChange();
        }

        function reset() {
            state = Object.assign({}, DEFAULTS);
            save();
            restore();
            if (parts && parts.viewer) parts.viewer.classList.remove('pdl-managed');
            document.body.classList.remove('pdl-managed');
            lastGeometry = null;
            origStyles = null;
            parts = null;
            try { window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
            setTimeout(() => {
                parts = findParts();
                if (parts) { snapshot(); startObserver(); scheduleHandle(); }
            }, 250);
            if (onChange) onChange();
        }

        function currentRatio() {
            if (!parts) parts = findParts();
            if (!parts) return 0.42;
            if (typeof state.ratio === 'number') return state.ratio;
            const W = parts.viewer.getBoundingClientRect().width;
            const l = parts.leftPane.getBoundingClientRect().width;
            return W > 0 ? clamp(l / W, 0.16, 0.72) : 0.42;
        }

        function buildHandle() {
            if (handle || !IS_TOP) return;
            handle = document.createElement('div');
            handle.id = 'pdl-splitter';
            handle.tabIndex = 0;
            handle.setAttribute('role', 'separator');
            handle.setAttribute('aria-orientation', 'vertical');
            handle.setAttribute('aria-label', 'Resize the video and sidebar');
            handle.innerHTML =
                '<div class="pdl-split-line"></div>' +
                '<div class="pdl-split-grip">' + icon('grip', 12) + '</div>' +
                '<button class="pdl-split-collapse" type="button" title="Hide the sidebar column" aria-label="Hide the sidebar column">' + icon('chevronLeft', 13) + '</button>';
            document.body.appendChild(handle);

            handle.querySelector('.pdl-split-collapse').addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setCollapsed(true);
            });

            let drag = null;
            handle.addEventListener('pointerdown', (e) => {
                if (state.collapsed) return;
                if (e.target.closest('.pdl-split-collapse')) return;
                if (e.button !== 0) return;
                const lr = parts ? parts.leftPane.getBoundingClientRect() : null;
                const mr = parts ? parts.main.getBoundingClientRect() : null;
                if (!lr || !mr) return;
                const horizontal = !(lr.left < mr.left);
                drag = {
                    id: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    startW: lr.width,
                    startH: lr.height,
                    viewerW: parts.viewer.getBoundingClientRect().width,
                    viewerH: parts.viewer.getBoundingClientRect().height,
                    horizontal
                };
                try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                document.body.classList.add('pdl-resizing');
                if (horizontal) document.body.classList.add('pdl-resizing-row');
                handle.classList.add('pdl-split-dragging');
                e.preventDefault();
            });

            handle.addEventListener('pointermove', (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                if (drag.horizontal) {
                    const delta = e.clientY - drag.startY;
                    const camH = clamp(drag.startH + delta, 80, drag.viewerH - 120);
                    // Only vertical split is used on the Panopto viewer; keep it graceful.
                    if (parts && parts.leftPlayer) parts.leftPlayer.style.height = Math.round(camH) + 'px';
                } else {
                    const delta = e.clientX - drag.startX;
                    const ratio = (drag.startW + delta) / drag.viewerW;
                    setRatio(ratio);
                }
                e.preventDefault();
            });

            const endDrag = (e) => {
                if (!drag) return;
                drag = null;
                document.body.classList.remove('pdl-resizing', 'pdl-resizing-row');
                handle.classList.remove('pdl-split-dragging');
                try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            };
            handle.addEventListener('pointerup', endDrag);
            handle.addEventListener('pointercancel', endDrag);

            handle.addEventListener('dblclick', (e) => {
                e.preventDefault();
                if (state.collapsed) { setCollapsed(false); return; }
                state.ratio = null;
                save();
                apply();
                if (onChange) onChange();
            });

            if (window.__PDL_HARNESS__) {
                window.__PDL_SPLIT_DEBUG__ = () => {
                    const lr = parts ? parts.leftPane.getBoundingClientRect() : null;
                    const mr = parts ? parts.main.getBoundingClientRect() : null;
                    return {
                        drag: drag ? Object.assign({}, drag) : null,
                        state: Object.assign({}, state),
                        left: lr ? { left: lr.left, width: lr.width } : null,
                        main: mr ? { left: mr.left, width: mr.width } : null,
                        viewerW: parts ? parts.viewer.getBoundingClientRect().width : null
                    };
                };
            }

            handle.addEventListener('keydown', (e) => {
                if (state.collapsed) {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(false); }
                    return;
                }
                const step = e.shiftKey ? 0.04 : 0.015;
                if (e.key === 'ArrowLeft') { e.preventDefault(); setRatio(currentRatio() - step); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); setRatio(currentRatio() + step); }
                else if (e.key === 'Home') { e.preventDefault(); setRatio(0.16); }
                else if (e.key === 'End') { e.preventDefault(); setRatio(0.72); }
            });

            window.addEventListener('scroll', scheduleHandle, { passive: true });
            window.addEventListener('resize', () => {
                scheduleHandle();
                if (typeof state.ratio === 'number' || !state.camera || !state.slides || state.collapsed) {
                    scheduleApply(120);
                }
            });
            if (window.ResizeObserver) {
                const ro = new ResizeObserver(scheduleHandle);
                // Observe lazily once the viewer exists.
                const attach = setInterval(() => {
                    const v = document.getElementById('viewerContent');
                    if (v) { ro.observe(v); clearInterval(attach); }
                }, 500);
            }
        }

        function init() {
            if (!IS_TOP) return;
            buildHandle();
            document.addEventListener('click', (e) => {
                if (e.target.closest && e.target.closest('#eventTabControl .event-tab-header')) {
                    // Do not re-run the whole layout on a tab switch; just make
                    // the newly active pane fill the current sidebar width.
                    suppressUntil = Date.now() + 1200;
                    setTimeout(syncPaneWidths, 180);
                    setTimeout(syncPaneWidths, 650);
                }
            }, true);
            const attach = () => {
                parts = findParts();
                if (!parts) return false;
                snapshot();
                if (handle) handle.style.display = parts.singleStream ? 'none' : '';
                startObserver();
                watchPaneWidths();
                if (!parts.singleStream && (typeof state.ratio === 'number' || !state.camera || !state.slides || state.collapsed)) {
                    apply();
                }
                scheduleHandle();
                document.addEventListener('loadedmetadata', () => scheduleApply(80), true);
                return true;
            };
            if (!attach()) {
                const timer = setInterval(() => {
                    if (attach()) clearInterval(timer);
                }, 500);
                setTimeout(() => clearInterval(timer), 60000);
            }
            // SPA navigation back to a viewer
            window.addEventListener('popstate', () => setTimeout(() => { parts = null; origStyles = null; attach(); }, 400));
        }

        function isSingleStream() {
            parts = parts || findParts();
            return !!(parts && parts.singleStream);
        }

        return {
            init, apply, reset, setRatio, setCamera, setSlides, setCollapsed,
            isSingleStream,
            currentRatio,
            getState: () => Object.assign({}, state),
            set onChange(fn) { onChange = fn; }
        };
    })();

    /* ============================================================
       DELIVERY INFO + STREAM PICKER
       ============================================================ */

    const Streams = (() => {
        let cache = null; // { id, at, data }
        let sizeCache = new Map();

        function videoId() {
            const p = new URLSearchParams(location.search);
            return p.get('id') || p.get('tid') || null;
        }

        function isTid() {
            const p = new URLSearchParams(location.search);
            return !p.get('id') && !!p.get('tid');
        }

        function request(id) {
            return new Promise((resolve, reject) => {
                const tid = isTid();
                const body = tid
                    ? 'tid=' + encodeURIComponent(id) + '&isLiveNotes=false&refreshAuthCookie=true&isActiveBroadcast=false&isEditing=false&isKollectiveAgentInstalled=false&isEmbed=false&responseType=json'
                    : [
                        'deliveryId=' + encodeURIComponent(id),
                        'invocationId=',
                        'isLiveNotes=false',
                        'refreshAuthCookie=true',
                        'isActiveBroadcast=false',
                        'isEditing=false',
                        'isKollectiveAgentInstalled=false',
                        'isEmbed=true',
                        'responseType=json'
                    ].join('&');

                gmXhr({
                    method: 'POST',
                    url: location.origin + '/Panopto/Pages/Viewer/DeliveryInfo.aspx',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        'Accept': 'application/json'
                    },
                    data: body,
                    timeout: 20000,
                    onload: (res) => {
                        if (res.status !== 200) {
                            reject(new Error('Panopto returned HTTP ' + res.status));
                            return;
                        }
                        let data;
                        try { data = JSON.parse(res.responseText); }
                        catch (e) { reject(new Error('Panopto returned invalid JSON')); return; }
                        if (data && data.ErrorCode) {
                            reject(new Error(data.ErrorMessage || ('Panopto error ' + data.ErrorCode)));
                            return;
                        }
                        if (!data || !data.Delivery) {
                            reject(new Error('This recording is not ready yet.'));
                            return;
                        }
                        resolve(data);
                    },
                    onerror: () => reject(new Error('Could not reach Panopto. Check your connection.')),
                    ontimeout: () => reject(new Error('Panopto took too long to answer.'))
                });
            });
        }

        async function load(force) {
            const id = videoId();
            if (!id) throw new Error('No video id in the page URL.');
            if (!force && cache && cache.id === id && Date.now() - cache.at < 5 * 60 * 1000) {
                return cache.data;
            }
            const data = await request(id);
            cache = { id, at: Date.now(), data };
            return data;
        }

        function resolveUrl(url) {
            try {
                const u = new URL(url, location.origin);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
                return u.href;
            } catch (e) {
                return null;
            }
        }

        function classify(tag, name, index, total) {
            const t = String(tag || name || '').toLowerCase();
            if (/^(dv|dvcam|ic)$/.test(t) || /presenter|camera|webcam|lecturer|speaker/.test(t)) return { kind: 'camera', label: 'Camera' };
            if (/screen|slide|object|presentation|desktop|visual|powerpoint/.test(t)) return { kind: 'screen', label: 'Slides' };
            if (/audio|voice|sound/.test(t)) return { kind: 'audio', label: 'Audio' };
            if (!tag || t === 'object') return { kind: 'stream', label: total > 1 ? 'Stream ' + (index + 1) : 'Stream' };
            const cleaned = String(tag).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
            return { kind: 'stream', label: cleaned || ('Stream ' + (index + 1)) };
        }

        function normalise(data) {
            const d = (data && data.Delivery) || {};
            const out = [];
            const seen = new Set();
            const podcasts = Array.isArray(d.PodcastStreams) ? d.PodcastStreams : [];
            const raw = Array.isArray(d.Streams) ? d.Streams : [];

            podcasts.forEach((s, i) => {
                const url = resolveUrl(s && (s.StreamUrl || s.StreamHttpUrl));
                if (!url || seen.has(url)) return;
                seen.add(url);
                const hls = String(s && s.ViewerMediaFileTypeName || '').toLowerCase() === 'hls' || /\.m3u8(\?|$)/i.test(url) || /\.panobf\d+/i.test(url);
                out.push({
                    url,
                    kind: 'combined',
                    label: podcasts.length > 1 ? 'Combined ' + (i + 1) : 'Combined',
                    tag: 'Combined',
                    isHls: hls,
                    ext: hls ? 'm3u8' : 'mp4',
                    note: 'Camera + slides in one file',
                    size: 0
                });
            });

            let streamIndex = 0;
            const streamTotal = raw.length;
            raw.forEach((s) => {
                const url = resolveUrl(s && (s.StreamUrl || s.StreamHttpUrl));
                if (!url || seen.has(url)) return;
                seen.add(url);
                const info = classify(s && (s.Tag || s.Name || s.StreamType), s && s.Name, streamIndex++, streamTotal);
                const hls = String(s && s.ViewerMediaFileTypeName || '').toLowerCase() === 'hls' || /\.m3u8(\?|$)/i.test(url) || /\.panobf\d+/i.test(url);
                out.push({
                    url,
                    kind: info.kind,
                    label: info.label,
                    tag: s && (s.Tag || s.Name) || '',
                    isHls: hls,
                    ext: hls ? 'm3u8' : 'mp4',
                    note: hls ? 'HLS stream, resolved to MP4' : (info.kind === 'screen' ? 'Slides / screen recording' : info.kind === 'camera' ? 'Presenter camera' : 'Direct MP4 file'),
                    size: 0
                });
            });

            // De-duplicate labels.
            const counts = {};
            out.forEach(s => { counts[s.label] = (counts[s.label] || 0) + 1; });
            const seenLabels = {};
            out.forEach(s => {
                if (counts[s.label] > 1) {
                    seenLabels[s.label] = (seenLabels[s.label] || 0) + 1;
                    s.label += ' ' + seenLabels[s.label];
                }
            });

            const order = { combined: 0, screen: 1, camera: 2, audio: 3, stream: 4 };
            out.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
            return out;
        }

        function headerValue(headers, name) {
            if (!headers) return '';
            const re = new RegExp('^' + name + ':\\s*(.+)$', 'im');
            const m = String(headers).match(re);
            return m ? m[1].trim() : '';
        }

        function fetchSize(url) {
            if (!url || /^blob:/i.test(url)) return Promise.resolve(0);
            if (sizeCache.has(url)) return sizeCache.get(url);
            const promise = new Promise((resolve) => {
                let done = false;
                const finish = (n) => {
                    if (done) return;
                    done = true;
                    resolve(n > 0 ? n : 0);
                };
                gmXhr({
                    method: 'HEAD',
                    url,
                    timeout: 9000,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            const len = Number(headerValue(res.responseHeaders, 'content-length'));
                            if (len > 0) { finish(len); return; }
                        }
                        // Fall back to a one-byte range request.
                        gmXhr({
                            method: 'GET',
                            url,
                            headers: { 'Range': 'bytes=0-0' },
                            timeout: 9000,
                            onload: (r2) => {
                                const range = headerValue(r2.responseHeaders, 'content-range');
                                const m = range.match(/\/(\d+)\s*$/);
                                finish(m ? Number(m[1]) : 0);
                            },
                            onerror: () => finish(0),
                            ontimeout: () => finish(0)
                        });
                    },
                    onerror: () => finish(0),
                    ontimeout: () => finish(0)
                });
            });
            sizeCache.set(url, promise);
            return promise;
        }

        const CAPTION_LANGS = {
            0: 'English (US)', 1: 'English (UK)', 2: 'Spanish (MX)', 3: 'Spanish (ES)', 4: 'German',
            5: 'French', 6: 'Dutch', 7: 'Thai', 8: 'Chinese (Simplified)', 9: 'Chinese (Traditional)',
            10: 'Korean', 11: 'Japanese', 12: 'Russian', 13: 'Portuguese (PT)', 14: 'Polish',
            15: 'English (AU)', 16: 'Danish', 17: 'Finnish', 18: 'Hungarian', 19: 'Norwegian',
            20: 'Swedish', 21: 'Italian'
        };

        function fetchText(url) {
            return new Promise((resolve, reject) => {
                gmXhr({
                    method: 'GET',
                    url,
                    timeout: 20000,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) resolve(res.responseText);
                        else reject(new Error('HTTP ' + res.status));
                    },
                    onerror: () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Timed out'))
                });
            });
        }

        function parseVariant(text, base) {
            const lines = text.split(/\r?\n/);
            let best = null;
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i].trim();
                if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
                const bw = Number((line.match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
                const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
                const pixels = res ? Number(res[1]) * Number(res[2]) : 0;
                let j = i + 1;
                while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j += 1;
                if (j >= lines.length) break;
                const url = new URL(lines[j].trim(), base).href;
                const score = pixels || bw;
                if (!best || score > best.score) best = { url, score };
            }
            return best;
        }

        function parseMedia(text, base) {
            if (/#EXT-X-KEY:(?!METHOD=NONE)/i.test(text)) {
                return { url: null, why: 'This HLS stream is encrypted (AES-128)' };
            }
            const lines = text.split(/\r?\n/);
            const parts = [];
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i].trim();
                if (line.startsWith('#EXT-X-BYTERANGE:')) {
                    const m = line.match(/#EXT-X-BYTERANGE:(\d+)@(\d+)/);
                    let j = i + 1;
                    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j += 1;
                    if (m && j < lines.length) {
                        parts.push({ url: new URL(lines[j].trim(), base).href, start: Number(m[2]), len: Number(m[1]) });
                    }
                } else if (line && !line.startsWith('#')) {
                    parts.push({ url: new URL(line, base).href, start: 0, len: null });
                }
            }
            if (!parts.length) return { url: null, why: 'Empty HLS playlist' };
            const urls = new Set(parts.map(p => p.url));
            if (urls.size === 1) {
                let size = 0;
                if (parts.every(p => p.len)) size = Math.max.apply(null, parts.map(p => p.start + p.len));
                return { url: parts[0].url, size, why: '' };
            }
            return { url: null, why: 'HLS uses separate segment files; use VLC or yt-dlp' };
        }

        async function resolveHls(url) {
            const master = await fetchText(url);
            if (!/#EXT-X-STREAM-INF/i.test(master)) return parseMedia(master, url);
            const best = parseVariant(master, url);
            if (!best) throw new Error('No HLS variants in the playlist');
            const media = await fetchText(best.url);
            const resolved = parseMedia(media, best.url);
            if (resolved.why) throw new Error(resolved.why);
            return resolved;
        }

        function captionLanguages(data) {            const d = (data && data.Delivery) || {};
            const langs = Array.isArray(d.AvailableLanguages) ? d.AvailableLanguages : [];
            return langs.map(l => ({
                id: String(l),
                name: CAPTION_LANGS[String(l)] || ('Language ' + l)
            }));
        }

        function fetchCaptions(lang) {
            const id = videoId();
            return new Promise((resolve, reject) => {
                const body = (isTid() ? 'tid=' : 'deliveryId=') + encodeURIComponent(id) +
                    '&getCaptions=true&language=' + encodeURIComponent(lang) + '&responseType=json';
                gmXhr({
                    method: 'POST',
                    url: location.origin + '/Panopto/Pages/Viewer/DeliveryInfo.aspx',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        'Accept': 'application/json'
                    },
                    data: body,
                    timeout: 30000,
                    onload: (res) => {
                        if (res.status !== 200) { reject(new Error('HTTP ' + res.status)); return; }
                        try {
                            const parsed = JSON.parse(res.responseText);
                            resolve(Array.isArray(parsed) ? parsed : []);
                        } catch (e) {
                            reject(new Error('Captions were not valid JSON'));
                        }
                    },
                    onerror: () => reject(new Error('Could not download captions')),
                    ontimeout: () => reject(new Error('Captions timed out'))
                });
            });
        }

        function srtTime(seconds) {
            const s = Math.max(0, Number(seconds) || 0);
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.floor(s % 60);
            const ms = Math.round((s - Math.floor(s)) * 1000);
            const pad = (n, w) => String(n).padStart(w, '0');
            return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(sec, 2) + ',' + pad(ms, 3);
        }

        function toSrt(cues, fallbackDuration) {
            const lines = [];
            let n = 0;
            cues.forEach((cue, i) => {
                if (!cue || cue.Caption == null) return;
                const start = Number(cue.Time) || 0;
                let end = start + (Number(cue.CaptionDuration) || 0);
                if (!cue.CaptionDuration) {
                    const next = cues[i + 1];
                    end = (next && next.Time) || fallbackDuration || (start + 2);
                }
                if (end <= start) end = start + 2;
                n += 1;
                lines.push(n + '\n' + srtTime(start) + ' --> ' + srtTime(end) + '\n' + String(cue.Caption).replace(/\r?\n/g, ' '));
            });
            return lines.join('\n\n') + '\n';
        }

        function saveBlob(name, text) {
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }

        return { load, normalise, videoId, fetchSize, isTid, captionLanguages, fetchCaptions, toSrt, saveBlob, resolveHls };
    })();

    /* ============================================================
       DOWNLOAD MANAGER (cross-tab aware)
       ============================================================ */

    const Downloads = (() => {
        let items = [];
        let handles = new Map();
        let lastBroadcast = new Map();
        let lastSave = 0;
        let saveTimer = 0;
        let renderTimer = 0;
        let bc = null;
        let onUpdate = null;

        function validItem(x) {
            return x && typeof x === 'object' && typeof x.id === 'string' && typeof x.url === 'string';
        }

        function normaliseItem(x) {
            return {
                id: String(x.id),
                title: String(x.title || 'Panopto video'),
                url: String(x.url || ''),
                session: String(x.session || ''),
                started: Number(x.started) || Date.now(),
                updated: Number(x.updated) || Date.now(),
                status: ['downloading', 'queued', 'complete', 'error', 'interrupted', 'browser'].includes(x.status) ? x.status : 'interrupted',
                progress: typeof x.progress === 'number' ? x.progress : null,
                loaded: Number(x.loaded) || 0,
                total: Number(x.total) || 0,
                speed: Number(x.speed) || 0,
                error: x.error ? String(x.error) : null,
                owner: String(x.owner || ''),
                saveAs: !!x.saveAs
            };
        }

        function merge(a, b) {
            const map = new Map();
            for (const raw of a.concat(b)) {
                if (!validItem(raw)) continue;
                const it = normaliseItem(raw);
                const prev = map.get(it.id);
                if (!prev) { map.set(it.id, it); continue; }
                map.set(it.id, (it.updated || 0) >= (prev.updated || 0) ? Object.assign({}, prev, it) : Object.assign({}, it, prev));
            }
            return Array.from(map.values()).sort((x, y) => (y.started || 0) - (x.started || 0)).slice(0, MAX_HISTORY);
        }

        function load() {
            const stored = store.get(K.history, []);
            items = Array.isArray(stored) ? merge(stored, []) : [];
            const now = Date.now();
            let changed = false;
            for (const it of items) {
                if (it.status === 'downloading' && it.owner !== TAB_ID && now - it.updated > 12000) {
                    it.status = 'interrupted';
                    it.error = 'Interrupted - the download tab was closed';
                    it.updated = now;
                    changed = true;
                }
            }
            if (changed) saveNow();
            initBroadcast();
        }

        function saveNow() {
            const stored = store.get(K.history, []);
            const merged = merge(Array.isArray(stored) ? stored : [], items);
            items = merged;
            store.set(K.history, merged);
            lastSave = Date.now();
        }

        function save() {
            if (saveTimer) return;
            const wait = Math.max(0, 700 - (Date.now() - lastSave));
            saveTimer = setTimeout(() => {
                saveTimer = 0;
                saveNow();
            }, wait);
        }

        function initBroadcast() {
            if (bc) return;
            try {
                if (typeof BroadcastChannel !== 'function') return;
                bc = new BroadcastChannel(BC_NAME);
                bc.onmessage = (event) => {
                    const msg = event.data;
                    if (!msg || typeof msg !== 'object') return;
                    if (msg.tabId === TAB_ID) return;

                    if (msg.type === 'hello') {
                        const live = items.filter(it => it.owner === TAB_ID && (it.status === 'downloading' || it.status === 'queued'));
                        if (live.length) broadcast({ type: 'live', tabId: TAB_ID, items: live });
                    } else if (msg.type === 'live') {
                        if (Array.isArray(msg.items)) {
                            items = merge(items, msg.items);
                            save();
                            notify();
                        }
                    } else if (msg.type === 'add' || msg.type === 'patch') {
                        if (msg.item) {
                            items = merge(items, [msg.item]);
                            save();
                            notify();
                        }
                    } else if (msg.type === 'gone') {
                        let changed = false;
                        const now = Date.now();
                        for (const it of items) {
                            if (it.owner === msg.tabId && it.status === 'downloading') {
                                it.status = 'interrupted';
                                it.error = 'Interrupted - the download tab was closed';
                                it.updated = now;
                                changed = true;
                            }
                        }
                        if (changed) { saveNow(); notify(); }
                    } else if (msg.type === 'cancel') {
                        if (msg.owner === TAB_ID) abortLocal(msg.id);
                    }
                };
            } catch (e) {
                bc = null;
            }
        }

        function broadcast(msg) {
            if (!bc) return;
            try { bc.postMessage(msg); } catch (e) { /* ignore */ }
        }

        function notify() {
            if (onUpdate) onUpdate();
        }

        function push(item, force) {
            items = merge(items, [item]);
            const now = Date.now();
            if (force || now - (lastBroadcast.get(item.id) || 0) > 240) {
                lastBroadcast.set(item.id, now);
                broadcast({ type: 'patch', tabId: TAB_ID, item });
            }
            save();
            notify();
        }

        function findAll(id) {
            return items.find(it => it.id === id) || null;
        }

        function setStatus(id, patch, opts) {
            const it = findAll(id);
            if (!it) return;
            Object.assign(it, patch, { updated: Date.now() });
            if (opts && opts.silent) {
                save();
            } else {
                push(it, true);
            }
        }

        function currentSessionTitle(data) {
            const d = (data && data.Delivery) || {};
            const title = d.SessionName || ($('#deliveryTitle') && $('#deliveryTitle').textContent) || document.title.replace(/^.*?›\s*/, '');
            return String(title || 'Panopto video').replace(/^Panopto\s*[·|-]\s*/i, '').trim();
        }

        function makeFilename(session, stream) {
            const base = sanitizeFilename(session, 'panopto-video');
            if (stream.kind === 'combined') return sanitizeFilename(base + '.' + stream.ext, 'panopto-video.mp4');
            return sanitizeFilename(base + ' - ' + stream.label + '.' + stream.ext, 'panopto-video.mp4');
        }

        function runDownload(item) {
            item.status = 'downloading';
            item.progress = item.total ? Math.min(100, (item.loaded / item.total) * 100) : null;
            item.error = null;
            item.updated = Date.now();
            push(item, true);

            if (typeof GM_download !== 'function') {
                // Fallback: hand the direct URL to the browser.
                const a = document.createElement('a');
                a.href = item.url;
                a.download = item.title;
                a.rel = 'noreferrer';
                document.body.appendChild(a);
                a.click();
                a.remove();
                item.status = 'browser';
                item.progress = null;
                item.updated = Date.now();
                push(item, true);
                toast('Sent to the browser download manager', 'success');
                return;
            }

            const stats = { lastAt: Date.now(), lastLoaded: 0 };
            let handle = null;
            try {
                handle = GM_download({
                    url: item.url,
                    name: item.title,
                    saveAs: item.saveAs,
                    onprogress: (p) => {
                        const now = Date.now();
                        const loaded = Math.max(0, Number(p && p.loaded) || 0);
                        let total = Math.max(0, Number(p && p.total) || 0);
                        if (!total && item.total) total = item.total;
                        const dt = now - stats.lastAt;
                        if (dt > 250) {
                            const db = loaded - stats.lastLoaded;
                            if (db > 0) {
                                const inst = db * 1000 / dt;
                                item.speed = item.speed ? (item.speed * 0.65 + inst * 0.35) : inst;
                            }
                            stats.lastAt = now;
                            stats.lastLoaded = loaded;
                        }
                        item.loaded = loaded;
                        if (total > 0) {
                            item.total = total;
                            item.progress = Math.min(100, loaded / total * 100);
                        } else {
                            item.progress = null;
                        }
                        if (item.status !== 'downloading') item.status = 'downloading';
                        item.updated = now;
                        push(item, false);
                        tickDom(item);
                    },
                    onload: () => {
                        handles.delete(item.id);
                        item.loaded = item.total || item.loaded;
                        item.progress = 100;
                        item.speed = 0;
                        item.status = 'complete';
                        item.error = null;
                        item.updated = Date.now();
                        push(item, true);
                        toast('Saved ' + item.title, 'success');
                    },
                    onerror: (err) => {
                        handles.delete(item.id);
                        const code = String((err && (err.error || err.message || err.details)) || '').toLowerCase();
                        const cancelled = /cancel|abort|user/.test(code);
                        item.status = 'interrupted';
                        item.error = cancelled ? 'Cancelled' : ('Download failed' + (code ? ' (' + code + ')' : ''));
                        item.speed = 0;
                        item.updated = Date.now();
                        push(item, true);
                        if (!cancelled) toast('Download failed: ' + item.title, 'error');
                    },
                    ontimeout: () => {
                        handles.delete(item.id);
                        item.status = 'error';
                        item.error = 'Download timed out';
                        item.speed = 0;
                        item.updated = Date.now();
                        push(item, true);
                    }
                });
            } catch (e) {
                item.status = 'error';
                item.error = e && e.message ? e.message : 'Could not start the download';
                item.speed = 0;
                item.updated = Date.now();
                push(item, true);
                return;
            }
            if (handle && typeof handle.abort === 'function') handles.set(item.id, handle);

            // GM_download sometimes reports total=0. Ask the server for Content-Length.
            if (!item.total) {
                Streams.fetchSize(item.url).then(size => {
                    if (!size) return;
                    const it = findAll(item.id);
                    if (!it || it.status !== 'downloading' || it.total) return;
                    it.total = size;
                    it.progress = Math.min(100, (it.loaded / size) * 100);
                    it.updated = Date.now();
                    push(it, true);
                    tickDom(it);
                });
            }
        }

        async function start(stream, data, saveAs) {
            const session = currentSessionTitle(data);
            const duplicate = items.find(it => it.url === stream.url && (it.status === 'downloading' || it.status === 'queued'));
            if (duplicate) {
                toast('That stream is already downloading', 'error');
                return null;
            }
            const initialStream = stream.isHls ? Object.assign({}, stream, { ext: 'mp4', isHls: false }) : stream;
            const item = normaliseItem({
                id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                title: makeFilename(session, initialStream),
                url: stream.url,
                session,
                started: Date.now(),
                updated: Date.now(),
                status: 'queued',
                progress: stream.size ? 0 : null,
                loaded: 0,
                total: stream.size || 0,
                speed: 0,
                error: null,
                owner: TAB_ID,
                saveAs: !!saveAs
            });
            items = merge(items, [item]);
            broadcast({ type: 'add', tabId: TAB_ID, item });
            save();
            notify();

            if (stream.isHls) {
                // Panopto serves the per-stream HLS as one fragmented MP4 with
                // byte ranges. Resolve the highest variant, then download it
                // like any other file (GM_download streams to disk).
                try {
                    const resolved = await Streams.resolveHls(stream.url);
                    const it = findAll(item.id);
                    if (!it) return null;
                    it.url = resolved.url;
                    it.title = makeFilename(session, { kind: stream.kind, label: stream.label, ext: 'mp4', isHls: false });
                    it.total = resolved.size || 0;
                    it.progress = 0;
                    it.updated = Date.now();
                    push(it, true);
                    runDownload(it);
                    return it;
                } catch (e) {
                    setStatus(item.id, {
                        status: 'error',
                        error: (e && e.message) ? e.message : 'Could not resolve this HLS stream',
                        speed: 0
                    });
                    toast('HLS: ' + ((e && e.message) || 'unsupported playlist'), 'error');
                    return null;
                }
            }

            runDownload(item);
            return item;
        }

        function abortLocal(id) {
            const h = handles.get(id);
            if (h) {
                try { h.abort(); } catch (e) { /* ignore */ }
                handles.delete(id);
            }
            const it = findAll(id);
            if (it && it.status === 'downloading') {
                it.status = 'interrupted';
                it.error = 'Cancelled';
                it.speed = 0;
                it.updated = Date.now();
                push(it, true);
            }
        }

        function cancel(id) {
            const it = findAll(id);
            if (!it) return;
            if (it.owner === TAB_ID) {
                abortLocal(id);
            } else {
                broadcast({ type: 'cancel', tabId: TAB_ID, owner: it.owner, id });
                it.status = 'interrupted';
                it.error = 'Cancelled';
                it.speed = 0;
                it.updated = Date.now();
                push(it, true);
            }
        }

        function retry(id) {
            const it = findAll(id);
            if (!it) return;
            const stream = {
                url: it.url,
                kind: it.title.includes(' - ') ? 'stream' : 'combined',
                label: 'Download',
                ext: /\.m3u8(\?|$)/i.test(it.url) ? 'm3u8' : 'mp4',
                isHls: /\.m3u8(\?|$)/i.test(it.url)
            };
            // Reuse the same filename and URL but start a fresh task.
            const item = normaliseItem({
                id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                title: it.title,
                url: it.url,
                session: it.session,
                started: Date.now(),
                updated: Date.now(),
                status: 'queued',
                total: it.total || 0,
                owner: TAB_ID,
                saveAs: it.saveAs
            });
            items = merge(items, [item]);
            broadcast({ type: 'add', tabId: TAB_ID, item });
            save();
            notify();
            runDownload(item);
        }

        function remove(id) {
            const it = findAll(id);
            if (!it) return;
            if (it.status === 'downloading' && it.owner === TAB_ID) abortLocal(id);
            items = items.filter(x => x.id !== id);
            saveNow();
            notify();
        }

        function clearFinished() {
            items = items.filter(it => it.status === 'downloading' || it.status === 'queued');
            saveNow();
            notify();
        }

        function activeCount() {
            return items.filter(it => it.status === 'downloading' || it.status === 'queued').length;
        }

        function all() {
            return items.slice();
        }

        function tickDom(item) {
            if (!IS_TOP) return;
            if (window.PDL_UI && window.PDL_UI.updateTask) window.PDL_UI.updateTask(item);
        }

        function probeTabs() {
            broadcast({ type: 'hello', tabId: TAB_ID });
            setTimeout(() => {
                const now = Date.now();
                let changed = false;
                for (const it of items) {
                    if (it.status === 'downloading' && it.owner !== TAB_ID && now - it.updated > 15000) {
                        it.status = 'interrupted';
                        it.error = 'Interrupted - no active download tab';
                        it.updated = now;
                        changed = true;
                    }
                }
                if (changed) { saveNow(); notify(); }
            }, 1600);
        }

        function init() {
            load();
            probeTabs();
            window.addEventListener('beforeunload', () => {
                broadcast({ type: 'gone', tabId: TAB_ID });
            });
            window.addEventListener('pagehide', (e) => {
                if (!e.persisted) broadcast({ type: 'gone', tabId: TAB_ID });
            });
        }

        // Harness-only introspection; never exposed in normal page use.
        if (typeof window !== 'undefined' && window.__PDL_HARNESS__) {
            window.__PDL_DEBUG__ = {
                items: () => items.slice(),
                activeCount,
                hasChannel: () => !!bc
            };
        }

        return {
            init, start, cancel, retry, remove, clearFinished, all, activeCount,
            set onUpdate(fn) { onUpdate = fn; }
        };
    })();

    /* ============================================================
       PANEL UI
       ============================================================ */

    const UI = (() => {
        let panel = null;
        let open = false;
        let lastTab = store.get(K.lastTab, 'streams');
        let data = null;
        let loading = false;
        let error = null;
        let taskNodes = new Map();
        let renderQueued = false;
        let activitySignature = '';
        let previousFocus = null;

        function h(tag, props, children) {
            const el = document.createElement(tag);
            if (props) {
                for (const key of Object.keys(props)) {
                    const val = props[key];
                    if (val == null || val === false) continue;
                    if (key === 'class') el.className = val;
                    else if (key === 'text') el.textContent = val;
                    else if (key === 'html') el.innerHTML = val;
                    else if (key === 'dataset') Object.assign(el.dataset, val);
                    else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
                    else if (val === true) el.setAttribute(key, '');
                    else el.setAttribute(key, String(val));
                }
            }
            if (children) {
                for (const child of [].concat(children)) {
                    if (child == null || child === false) continue;
                    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
                }
            }
            return el;
        }

        function build() {
            if (panel || !IS_TOP) return;
            panel = document.createElement('div');
            panel.id = 'pdl-panel';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', 'Panopto downloader and layout controls');
            panel.setAttribute('aria-hidden', 'true');
            panel.innerHTML = `
                <div id="pdl-header">
                    <div id="pdl-title">
                        <span class="pdl-title-ico">${icon('bolt', 17)}</span>
                        <span>Panopto DL</span>
                        <span id="pdl-active-pill">0</span>
                    </div>
                    <div id="pdl-head-actions">
                        <button class="pdl-head-btn" id="pdl-close" type="button" title="Close (Esc)" aria-label="Close">${icon('close', 17)}</button>
                    </div>
                </div>
                <div id="pdl-tabs" role="tablist" aria-label="Panopto DL views">
                    <button class="pdl-tab" type="button" role="tab" data-view="streams" aria-selected="true" aria-controls="pdl-view-streams">
                        ${icon('download', 14)}<span>Download</span><span class="pdl-tab-underline"></span>
                    </button>
                    <button class="pdl-tab" type="button" role="tab" data-view="activity" aria-selected="false" aria-controls="pdl-view-activity">
                        ${icon('history', 14)}<span>Activity</span><span class="pdl-tab-count" id="pdl-tab-count">0</span><span class="pdl-tab-underline"></span>
                    </button>
                    <button class="pdl-tab" type="button" role="tab" data-view="layout" aria-selected="false" aria-controls="pdl-view-layout">
                        ${icon('layout', 14)}<span>Layout</span><span class="pdl-tab-underline"></span>
                    </button>
                </div>
                <div id="pdl-body">
                    <section class="pdl-view" id="pdl-view-streams" role="tabpanel" aria-label="Download"></section>
                    <section class="pdl-view" id="pdl-view-activity" role="tabpanel" aria-label="Activity"></section>
                    <section class="pdl-view" id="pdl-view-layout" role="tabpanel" aria-label="Layout"></section>
                </div>
            `;
            document.body.appendChild(panel);
            makeDraggable();
            bindTabs();
            restorePosition();

            $('#pdl-close', panel).addEventListener('click', () => setOpen(false));
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && open) {
                    e.preventDefault();
                    setOpen(false);
                }
            });
            window.addEventListener('resize', () => { if (open) clampPosition(); });
            switchTab(lastTab, true);
        }

        function bindTabs() {
            $$('.pdl-tab', panel).forEach(tab => {
                tab.addEventListener('click', () => switchTab(tab.dataset.view));
            });
            $('#pdl-tabs', panel).addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                const tabs = $$('.pdl-tab', panel);
                const i = tabs.indexOf(document.activeElement);
                if (i < 0) return;
                e.preventDefault();
                const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                next.focus();
                switchTab(next.dataset.view);
            });
        }

        function switchTab(name, silent) {
            if (!name) name = 'streams';
            lastTab = name;
            store.set(K.lastTab, name);
            $$('.pdl-tab', panel).forEach(t => {
                const on = t.dataset.view === name;
                t.setAttribute('aria-selected', on ? 'true' : 'false');
                t.tabIndex = on ? 0 : -1;
            });
            $$('.pdl-view', panel).forEach(v => v.classList.toggle('pdl-active', v.id === 'pdl-view-' + name));
            if (name === 'streams') renderStreams();
            else if (name === 'activity') renderActivity();
            else if (name === 'layout') renderLayout();
            if (!silent) $('#pdl-body', panel).scrollTop = 0;
        }

        function setOpen(value) {
            if (!panel) return;
            open = !!value;
            panel.classList.toggle('pdl-open', open);
            panel.setAttribute('aria-hidden', open ? 'false' : 'true');
            if (open) {
                previousFocus = document.activeElement;
                clampPosition();
                if (Downloads.activeCount() > 0 && lastTab === 'streams') switchTab('activity');
                else switchTab(lastTab);
                setTimeout(() => { try { $('#pdl-close', panel).focus(); } catch (e) { /* ignore */ } }, 40);
            } else if (previousFocus && previousFocus.focus) {
                try { previousFocus.focus(); } catch (e) { /* ignore */ }
            }
        }

        function toggle() {
            setOpen(!open);
        }

        function makeDraggable() {
            const header = $('#pdl-header', panel);
            let drag = null;
            header.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button')) return;
                if (e.button !== 0) return;
                const r = panel.getBoundingClientRect();
                drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
                try { header.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                panel.style.transition = 'none';
                e.preventDefault();
            });
            header.addEventListener('pointermove', (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                const left = drag.left + (e.clientX - drag.x);
                const top = drag.top + (e.clientY - drag.y);
                panel.style.left = Math.round(left) + 'px';
                panel.style.top = Math.round(top) + 'px';
            });
            const end = (e) => {
                if (!drag) return;
                drag = null;
                panel.style.transition = '';
                clampPosition();
                savePosition();
                try { header.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            };
            header.addEventListener('pointerup', end);
            header.addEventListener('pointercancel', end);
            header.addEventListener('dblclick', (e) => {
                if (e.target.closest('button')) return;
                panel.style.left = '';
                panel.style.top = '';
                store.set(K.panelPos, null);
            });
        }

        function clampPosition() {
            if (!panel) return;
            const r = panel.getBoundingClientRect();
            const left = clamp(r.left, 8, Math.max(8, window.innerWidth - r.width - 8));
            const top = clamp(r.top, 8, Math.max(8, window.innerHeight - 80));
            panel.style.left = Math.round(left) + 'px';
            panel.style.top = Math.round(top) + 'px';
        }

        function savePosition() {
            if (!panel) return;
            const r = panel.getBoundingClientRect();
            store.set(K.panelPos, { left: Math.round(r.left), top: Math.round(r.top) });
        }

        function restorePosition() {
            const pos = store.get(K.panelPos, null);
            if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
                panel.style.left = pos.left + 'px';
                panel.style.top = pos.top + 'px';
            }
        }

        function setActiveBadges(count) {
            const pill = document.getElementById('pdl-active-pill');
            if (pill) {
                pill.textContent = count > 0 ? String(count) : '0';
                pill.classList.toggle('pdl-show', count > 0);
            }
            const tabCount = document.getElementById('pdl-tab-count');
            if (tabCount) {
                tabCount.textContent = count > 0 ? String(count) : '0';
                tabCount.classList.toggle('pdl-show', count > 0);
            }
            const sb = document.getElementById('panopto-dl-sidebar-btn');
            if (sb) sb.classList.toggle('pdl-has-active', count > 0);
        }

        function streamIcon(kind) {
            if (kind === 'camera') return icon('camera', 18);
            if (kind === 'screen') return icon('screen', 18);
            if (kind === 'audio') return icon('play', 18);
            return icon('combined', 18);
        }

        function renderStreams() {
            const view = document.getElementById('pdl-view-streams');
            if (!view || !panel) return;
            if (loading) {
                view.replaceChildren(h('div', { class: 'pdl-loading' }, [h('span', { class: 'pdl-spinner' }), h('span', { text: 'Reading streams from Panopto...' })]));
                return;
            }
            if (error) {
                view.replaceChildren(
                    h('div', { class: 'pdl-error-box', text: error }),
                    h('button', { class: 'pdl-text-btn', type: 'button', onclick: () => loadStreams(true) }, [h('span', { html: icon('refresh', 13) }), h('span', { text: 'Try again' })])
                );
                return;
            }
            if (!data) { loadStreams(false); return; }

            const title = currentTitle();
            const streams = Streams.normalise(data);
            const mp4 = streams.filter(s => !s.isHls).length;
            const hls = streams.length - mp4;

            const head = h('div', { class: 'pdl-session-head' }, [
                h('div', { class: 'pdl-session-name', text: title }),
                h('div', { class: 'pdl-session-meta' }, [
                    h('span', { text: streams.length + ' stream' + (streams.length === 1 ? '' : 's') }),
                    h('span', { class: 'pdl-dot-sep' }),
                    h('span', { text: mp4 + ' MP4' + (hls ? ' · ' + hls + ' HLS' : '') }),
                    h('span', { class: 'pdl-dot-sep' }),
                    h('button', { class: 'pdl-text-btn', type: 'button', title: 'Refresh streams', onclick: () => loadStreams(true) }, [h('span', { html: icon('refresh', 12) }), h('span', { text: 'Refresh' })])
                ])
            ]);
            view.replaceChildren(head);

            if (!streams.length) {
                view.appendChild(h('div', { class: 'pdl-empty' }, [
                    h('div', { class: 'pdl-empty-ico', html: icon('alert', 22) }),
                    h('div', { html: '<strong>No streams found.</strong><br>The recording may still be processing, or downloads may be disabled.' })
                ]));
                return;
            }

            const list = h('div', { class: 'pdl-stream-list' });
            streams.forEach(stream => list.appendChild(streamCard(stream, title)));
            view.appendChild(list);

            const langs = Streams.captionLanguages(data);
            if (langs.length) {
                view.appendChild(h('div', { class: 'pdl-section-title', style: 'margin-top:14px', text: 'Captions' }));
                langs.forEach(lang => view.appendChild(captionCard(lang, title)));
            }

            const hint = h('div', { class: 'pdl-faint', style: 'margin-top:10px;font-size:10.5px;line-height:1.5' });
            hint.textContent = 'Shift-click Download to choose a location. HLS streams are resolved to their highest-quality MP4 variant before downloading.';
            view.appendChild(hint);

            // Fill in sizes asynchronously.
            streams.forEach(stream => {
                if (stream.isHls) return;
                Streams.fetchSize(stream.url).then(size => {
                    if (!size) return;
                    stream.size = size;
                    const el = view.querySelector('[data-size-for="' + cssEscape(stream.url) + '"]');
                    if (el) el.textContent = formatBytes(size);
                });
            });
        }

        function cssEscape(s) {
            return String(s).replace(/"/g, '\\"');
        }

        function captionCard(lang, title) {
            const btn = h('button', {
                class: 'pdl-icon-btn',
                type: 'button',
                title: 'Download ' + lang.name + ' captions as SRT',
                'aria-label': 'Download ' + lang.name + ' captions',
                onclick: async () => {
                    btn.disabled = true;
                    try {
                        const cues = await Streams.fetchCaptions(lang.id);
                        if (!cues.length) { toast('No captions in ' + lang.name, 'error'); return; }
                        const d = (data && data.Delivery) || {};
                        const base = sanitizeFilename(title, 'panopto-captions');
                        Streams.saveBlob(base + ' - ' + lang.name + '.srt', Streams.toSrt(cues, d.Duration));
                        toast('Captions saved: ' + lang.name, 'success');
                    } catch (e) {
                        toast(e && e.message ? e.message : 'Caption download failed', 'error');
                    } finally {
                        btn.disabled = false;
                    }
                }
            }, [h('span', { html: icon('download', 16) })]);
            return h('div', { class: 'pdl-stream' }, [
                h('div', { class: 'pdl-stream-ico', html: icon('caption', 18) }),
                h('div', { class: 'pdl-stream-main' }, [
                    h('div', { class: 'pdl-stream-title' }, [
                        h('span', { text: lang.name }),
                        h('span', { class: 'pdl-chip', text: 'SRT' })
                    ]),
                    h('div', { class: 'pdl-stream-sub', text: 'Captions / transcript' })
                ]),
                h('div', { class: 'pdl-stream-actions' }, [btn])
            ]);
        }

        function currentTitle() {
            const d = (data && data.Delivery) || {};
            return String(d.SessionName || ($('#deliveryTitle') && $('#deliveryTitle').textContent) || document.title.replace(/^.*?›\s*/, '') || 'Panopto session').trim();
        }

        function streamCard(stream, title) {
            const sizeSpan = h('span', { text: stream.size ? formatBytes(stream.size) : (stream.isHls ? 'resolves to MP4' : 'MP4 video') });
            sizeSpan.setAttribute('data-size-for', stream.url);

            const sub = h('div', { class: 'pdl-stream-sub' }, [
                h('span', { text: stream.note }),
                h('span', { class: 'pdl-dot-sep' }),
                sizeSpan
            ]);

            const copyBtn = h('button', {
                class: 'pdl-icon-btn',
                type: 'button',
                title: 'Copy stream link',
                'aria-label': 'Copy stream link',
                onclick: () => {
                    if (copyText(stream.url)) {
                        copyBtn.innerHTML = icon('check', 16);
                        copyBtn.style.color = 'var(--pdl-accent-soft)';
                        setTimeout(() => { copyBtn.innerHTML = icon('link', 16); copyBtn.style.color = ''; }, 1100);
                        toast('Stream link copied', 'success');
                    } else {
                        toast('Could not copy the link', 'error');
                    }
                }
            }, [h('span', { html: icon('link', 16) })]);

            const actions = h('div', { class: 'pdl-stream-actions' }, [copyBtn]);
            const dl = h('button', {
                class: 'pdl-primary-btn',
                type: 'button',
                title: 'Download ' + stream.label + (stream.isHls ? ' (HLS resolved to MP4)' : '') + ' - Shift-click to choose a location',
                'aria-label': 'Download ' + stream.label,
                onclick: (e) => {
                    Downloads.start(stream, data, e.shiftKey || !!store.get(K.saveAs, false));
                    switchTab('activity');
                }
            }, [h('span', { html: icon('download', 16) })]);
            actions.appendChild(dl);

            return h('div', { class: 'pdl-stream' }, [
                h('div', { class: 'pdl-stream-ico', html: streamIcon(stream.kind) }),
                h('div', { class: 'pdl-stream-main' }, [
                    h('div', { class: 'pdl-stream-title' }, [
                        h('span', { text: stream.label }),
                        h('span', { class: 'pdl-chip' + (stream.isHls ? ' pdl-chip-warn' : ''), text: stream.isHls ? 'MP4' : stream.ext.toUpperCase() })
                    ]),
                    sub
                ]),
                actions
            ]);
        }

        async function loadStreams(force) {
            if (!panel) return;
            loading = true;
            error = null;
            renderStreams();
            try {
                data = await Streams.load(force);
                loading = false;
                renderStreams();
            } catch (e) {
                loading = false;
                error = e && e.message ? e.message : 'Could not load the stream list.';
                renderStreams();
            }
        }

        function statusText(it) {
            if (it.status === 'downloading') {
                if (it.progress == null) return 'Downloading';
                return 'Downloading ' + Math.floor(it.progress) + '%';
            }
            if (it.status === 'queued') return 'Starting';
            if (it.status === 'complete') return 'Saved';
            if (it.status === 'browser') return 'Sent to browser';
            if (it.status === 'interrupted') return 'Interrupted';
            return 'Failed';
        }

        function statusClass(it) {
            if (it.status === 'complete') return 'pdl-state-done';
            if (it.status === 'error' || it.status === 'interrupted') return 'pdl-state-err';
            return 'pdl-state-ok';
        }

        function taskNode(it) {
            const stateText = h('span', { class: 'pdl-task-state ' + statusClass(it), text: statusText(it) });
            const details = h('span', { class: 'pdl-task-detail', text: detailLine(it) });
            const detailDot = h('span', { class: 'pdl-dot-sep pdl-task-detail-dot' });
            if (!details.textContent) detailDot.style.display = 'none';
            if (!details.textContent) details.style.display = 'none';
            const bar = h('div', { class: 'pdl-task-bar' });
            const barWrap = h('div', { class: 'pdl-task-bar-wrap' }, [bar]);
            const foot = h('div', { class: 'pdl-task-foot' }, [
                h('span', { class: 'pdl-task-bytes', text: bytesLine(it) }),
                h('span', { class: 'pdl-task-eta', text: etaLine(it) })
            ]);
            const errorEl = h('div', { class: 'pdl-task-error', text: it.error || '' });
            const actions = h('div', { class: 'pdl-task-actions' });

            if (it.status === 'downloading' || it.status === 'queued') {
                actions.appendChild(h('button', {
                    class: 'pdl-mini-btn pdl-danger',
                    type: 'button',
                    title: 'Cancel download',
                    'aria-label': 'Cancel download',
                    onclick: () => Downloads.cancel(it.id)
                }, [h('span', { html: icon('close', 13) })]));
            } else {
                if (it.status !== 'complete' && it.status !== 'browser') {
                    actions.appendChild(h('button', {
                        class: 'pdl-mini-btn',
                        type: 'button',
                        title: 'Retry download',
                        'aria-label': 'Retry download',
                        onclick: () => Downloads.retry(it.id)
                    }, [h('span', { html: icon('refresh', 13) })]));
                }
                actions.appendChild(h('button', {
                    class: 'pdl-mini-btn pdl-danger',
                    type: 'button',
                    title: 'Remove from history',
                    'aria-label': 'Remove from history',
                    onclick: () => Downloads.remove(it.id)
                }, [h('span', { html: icon('trash', 13) })]));
            }

            const node = h('div', {
                class: 'pdl-task',
                dataset: { id: it.id, state: it.status }
            }, [
                h('div', { class: 'pdl-task-head' }, [
                    h('div', { class: 'pdl-task-ico', html: it.status === 'complete' ? icon('check', 14) : it.status === 'error' || it.status === 'interrupted' ? icon('alert', 14) : icon('download', 14) }),
                    h('div', { class: 'pdl-task-main' }, [
                        h('div', { class: 'pdl-task-title', text: it.title, title: it.title }),
                        h('div', { class: 'pdl-task-sub' }, [stateText, detailDot, details])
                    ]),
                    actions
                ]),
                barWrap,
                foot,
                errorEl
            ]);
            applyTaskNode(node, it);
            return node;
        }

        function detailLine(it) {
            if (it.status === 'downloading') {
                if (it.owner !== TAB_ID) return 'another tab';
                if (it.speed) return formatSpeed(it.speed);
                return 'starting';
            }
            return '';
        }

        function bytesLine(it) {
            if (!it.loaded && !it.total) return '';
            if (it.total) return formatBytes(it.loaded) + ' / ' + formatBytes(it.total);
            return formatBytes(it.loaded);
        }

        function etaLine(it) {
            if (it.status !== 'downloading') return '';
            if (it.total && it.speed) {
                const eta = (it.total - it.loaded) / it.speed;
                const text = formatEta(eta);
                if (text) return text + ' left';
            }
            if (it.progress != null) return Math.floor(it.progress) + '%';
            return '';
        }

        function applyTaskNode(node, it) {
            node.dataset.state = it.status;
            const stateEl = node.querySelector('.pdl-task-state');
            if (stateEl) {
                stateEl.textContent = statusText(it);
                stateEl.className = 'pdl-task-state ' + statusClass(it);
            }
            const detail = node.querySelector('.pdl-task-detail');
            if (detail) {
                detail.textContent = detailLine(it);
                detail.style.display = detail.textContent ? '' : 'none';
            }
            const detailDot = node.querySelector('.pdl-task-detail-dot');
            if (detailDot) detailDot.style.display = detail && detail.textContent ? '' : 'none';
            const bar = node.querySelector('.pdl-task-bar');
            if (bar) {
                bar.classList.toggle('pdl-bar-done', it.status === 'complete');
                bar.classList.toggle('pdl-bar-err', it.status === 'error' || it.status === 'interrupted');
                if (it.status === 'downloading' && it.progress == null) {
                    bar.classList.add('pdl-indeterminate');
                    bar.style.width = '';
                } else {
                    bar.classList.remove('pdl-indeterminate');
                    const pct = it.status === 'complete' ? 100 : (it.progress != null ? it.progress : (it.status === 'error' || it.status === 'interrupted' ? 100 : 0));
                    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
                }
            }
            const bytes = node.querySelector('.pdl-task-bytes');
            if (bytes) bytes.textContent = bytesLine(it);
            const eta = node.querySelector('.pdl-task-eta');
            if (eta) eta.textContent = etaLine(it);
            const err = node.querySelector('.pdl-task-error');
            if (err) {
                err.textContent = it.error || '';
                err.style.display = it.error ? '' : 'none';
            }
        }

        function renderActivity() {
            const view = document.getElementById('pdl-view-activity');
            if (!view) return;
            const all = Downloads.all();
            activitySignature = all.map(it => it.id + ':' + (it.status === 'downloading' || it.status === 'queued' ? 'a' : 'f')).join('|');
            taskNodes = new Map();
            view.replaceChildren();

            if (!all.length) {
                view.appendChild(h('div', { class: 'pdl-empty' }, [
                    h('div', { class: 'pdl-empty-ico', html: icon('history', 22) }),
                    h('div', { html: '<strong>No downloads yet.</strong><br>Pick a stream from the Download tab.' })
                ]));
                return;
            }

            const active = all.filter(it => it.status === 'downloading' || it.status === 'queued');
            const finished = all.filter(it => !(it.status === 'downloading' || it.status === 'queued'));

            view.appendChild(h('div', { class: 'pdl-summary' }, [
                h('span', { html: active.length ? '<strong>' + active.length + '</strong> active · ' + finished.length + ' finished' : '<strong>' + finished.length + '</strong> finished' }),
                h('button', {
                    class: 'pdl-text-btn',
                    type: 'button',
                    onclick: () => Downloads.clearFinished()
                }, [h('span', { html: icon('trash', 12) }), h('span', { text: 'Clear finished' })])
            ]));

            if (active.length) {
                view.appendChild(h('div', { class: 'pdl-section-title', text: 'Active' }));
                active.forEach(it => {
                    const node = taskNode(it);
                    taskNodes.set(it.id, node);
                    view.appendChild(node);
                });
            }
            if (finished.length) {
                view.appendChild(h('div', { class: 'pdl-section-title', text: active.length ? 'Recent' : 'History' }));
                finished.slice(0, 40).forEach(it => {
                    const node = taskNode(it);
                    taskNodes.set(it.id, node);
                    view.appendChild(node);
                });
            }
        }

        function updateTask(it) {
            if (!panel) return;
            const node = taskNodes.get(it.id);
            if (node && node.isConnected) {
                applyTaskNode(node, it);
                return;
            }
            if (lastTab === 'activity' && !renderQueued) {
                renderQueued = true;
                setTimeout(() => {
                    renderQueued = false;
                    if (lastTab === 'activity') renderActivity();
                }, 160);
            }
        }

        function renderLayout() {
            const view = document.getElementById('pdl-view-layout');
            if (!view) return;
            const state = Layout.getState();
            const hasViewer = !!document.getElementById('viewerContent');
            view.replaceChildren();

            if (!hasViewer) {
                view.appendChild(h('div', { class: 'pdl-empty' }, [
                    h('div', { class: 'pdl-empty-ico', html: icon('layout', 22) }),
                    h('div', { html: '<strong>Layout controls are for the full viewer.</strong><br>This page is an embed.' })
                ]));
                return;
            }

            const single = Layout.isSingleStream();
            if (single) {
                view.appendChild(h('div', { class: 'pdl-layout-intro', html:
                    'This recording has a single video stream, so Panopto\'s own layout is kept. ' +
                    'The divider and the camera/slides toggles are disabled here.'
                }));
            } else {
                view.appendChild(h('div', { class: 'pdl-layout-intro', html:
                    'Drag the divider between the sidebar and the slides. Double-click it to reset. ' +
                    'Use <kbd>←</kbd> / <kbd>→</kbd> when it is focused for fine steps.'
                }));

                const ratio = Layout.currentRatio();
                const range = h('input', {
                    class: 'pdl-range',
                    type: 'range',
                    min: '16',
                    max: '72',
                    step: '1',
                    value: String(Math.round(ratio * 100)),
                    'aria-label': 'Sidebar width'
                });
                const rangeVal = h('span', { class: 'pdl-range-val', text: state.slides ? Math.round(ratio * 100) + '%' : 'Full' });
                if (!state.slides) range.disabled = true;
                range.addEventListener('input', () => {
                    const v = Number(range.value) / 100;
                    rangeVal.textContent = range.value + '%';
                    Layout.setRatio(v);
                });

                view.appendChild(h('div', { class: 'pdl-row' }, [
                    h('div', { class: 'pdl-row-label' }, [
                        h('strong', { text: 'Sidebar width' }),
                        h('span', { text: 'Camera and tabs vs slides' })
                    ]),
                    h('div', { class: 'pdl-split-control', style: 'width:190px' }, [range, rangeVal])
                ]));

                view.appendChild(toggleRow('Camera stream', 'Show the presenter camera', state.camera, (on) => Layout.setCamera(on)));
                view.appendChild(toggleRow('Slides stream', 'Show the screen / slide capture', state.slides, (on) => Layout.setSlides(on)));
                view.appendChild(toggleRow('Focus slides', 'Hide the sidebar column (camera audio keeps playing)', state.collapsed, (on) => Layout.setCollapsed(on)));
            }
            view.appendChild(h('div', { class: 'pdl-row' }, [
                h('div', { class: 'pdl-row-label' }, [
                    h('strong', { text: 'Reset layout' }),
                    h('span', { text: 'Back to Panopto\'s default sizes' })
                ]),
                h('button', { class: 'pdl-text-btn', type: 'button', onclick: () => { Layout.reset(); renderLayout(); } }, [h('span', { html: icon('refresh', 12) }), h('span', { text: 'Reset' })])
            ]));

            view.appendChild(h('div', { class: 'pdl-section-title', style: 'margin-top:16px', text: 'Playback' }));
            view.appendChild(h('div', { class: 'pdl-row' }, [
                h('div', { class: 'pdl-row-label' }, [
                    h('strong', { text: single ? 'Resume playback' : 'Resume both streams' }),
                    h('span', { text: 'Fixes the pause / no-audio bug' })
                ]),
                h('button', { class: 'pdl-text-btn', type: 'button', onclick: () => { Player.playAll(); toast(single ? 'Playback resumed' : 'Both streams resumed', 'success'); } }, [h('span', { html: icon('play', 12) }), h('span', { text: 'Play' })])
            ]));

            view.appendChild(h('div', { class: 'pdl-section-title', style: 'margin-top:16px', text: 'Looks' }));
            const darkOn = document.body.classList.contains('pdl-dark');
            view.appendChild(toggleRow('Dark Panopto', 'Match the dark player theme', darkOn, (on) => applyDarkMode(on)));

            const saveAs = !!store.get(K.saveAs, false);
            view.appendChild(toggleRow('Ask where to save', 'Show the Save As dialog for every download', saveAs, (on) => store.set(K.saveAs, !!on)));
        }

        function toggleRow(label, hint, checked, onChange) {
            const input = h('input', { type: 'checkbox', 'aria-label': label });
            input.checked = !!checked;
            input.addEventListener('change', () => onChange(input.checked));
            return h('div', { class: 'pdl-row' }, [
                h('div', { class: 'pdl-row-label' }, [
                    h('strong', { text: label }),
                    h('span', { text: hint })
                ]),
                h('label', { class: 'pdl-switch' }, [input, h('span')])
            ]);
        }

        function refreshLayoutIfOpen() {
            if (lastTab === 'layout') renderLayout();
        }

        function init() {
            if (!IS_TOP) return;
            Downloads.onUpdate = () => {
                const n = Downloads.activeCount();
                setActiveBadges(n);
                if (lastTab !== 'activity') return;
                // Progress ticks must not rebuild the DOM: the cancel button
                // would be replaced between pointerdown and pointerup. Only a
                // change in the set of tasks needs a re-render.
                const items = Downloads.all();
                const signature = items.map(it => it.id + ':' + (it.status === 'downloading' || it.status === 'queued' ? 'a' : 'f')).join('|');
                if (signature !== activitySignature) {
                    activitySignature = signature;
                    if (!renderQueued) {
                        renderQueued = true;
                        setTimeout(() => {
                            renderQueued = false;
                            if (lastTab === 'activity') renderActivity();
                        }, 160);
                    }
                } else {
                    items.forEach(it => updateTask(it));
                }
            };
            Layout.onChange = () => {
                refreshLayoutIfOpen();
                setActiveBadges(Downloads.activeCount());
            };
            Downloads.init();
            Layout.init();
            build();
            // Build queues that were restored before the panel existed.
            setActiveBadges(Downloads.activeCount());
            // If the panel is closed, still keep the badges fresh.
            setInterval(() => setActiveBadges(Downloads.activeCount()), 4000);
            window.PDL_UI = { updateTask, toggle, isOpen: () => open };
        }

        return { init, toggle, isOpen: () => open, updateTask };
    })();

    /* ============================================================
       SIDEBAR BUTTON
       ============================================================ */

    /* ============================================================
       SCROLL GUARD
       Panopto auto-follows the playhead in the Contents pane and the
       thumbnail strip. That fights the user's own scrolling. While the user
       is interacting with one of those scrollers, block the programmatic
       writes (scrollTop/scrollLeft/scrollTo/scrollIntoView) for a few seconds.
       ============================================================ */

    /* ============================================================
       SCROLL GUARD

       Panopto's jQuery "scrollingHighlight" animates the thumbnail strip and
       the Contents pane to follow the playhead, one write per frame. A
       userscript manager that runs scripts in a sandbox (Violentmonkey and
       Tampermonkey on Firefox) wraps page objects in Xray wrappers: an
       accessor defined from the sandbox is invisible to the page's own
       jQuery, so it must be defined in the page context. The guard below is
       injected as a page script; the sandbox version is only a fallback for
       pages whose CSP blocks injection.

       While the user is scrolling, programmatic scroll writes are dropped
       for good. A click hands control back to Panopto, so clicking a
       thumbnail or a chapter lets it follow again.
       ============================================================ */

    function pageScrollGuard() {
        if (window.__pdlScrollGuardInstalled) return;
        window.__pdlScrollGuardInstalled = true;

        const pinned = new WeakSet();
        const proto = Element.prototype;

        if (!proto.__pdlScrollProtoPatched) {
            proto.__pdlScrollProtoPatched = true;
            const wrap = (name) => {
                const original = proto[name];
                if (typeof original !== 'function') return;
                proto[name] = function () {
                    if (name === 'scrollIntoView') {
                        let node = this;
                        while (node) {
                            if (pinned.has(node)) return;
                            node = node.parentElement;
                        }
                    } else if (pinned.has(this)) {
                        return;
                    }
                    return original.apply(this, arguments);
                };
            };
            wrap('scrollIntoView');
            wrap('scrollTo');
            wrap('scrollBy');
        }

        const guarded = new WeakSet();
        const install = (el) => {
            if (!el || guarded.has(el)) return;
            guarded.add(el);
            ['scrollLeft', 'scrollTop'].forEach(prop => {
                const desc = Object.getOwnPropertyDescriptor(proto, prop);
                if (!desc || !desc.get || !desc.set) return;
                try {
                    Object.defineProperty(el, prop, {
                        configurable: true,
                        get() { return desc.get.call(this); },
                        set(value) {
                            if (pinned.has(el)) return;
                            desc.set.call(this, value);
                        }
                    });
                } catch (e) { /* ignore */ }
            });
            // Any real user scroll stops the playhead follow until a click
            // says "take me there". No timer: the position must not snap back.
            el.addEventListener('wheel', () => pinned.add(el), { passive: true, capture: true });
            el.addEventListener('touchmove', () => pinned.add(el), { passive: true, capture: true });
            el.addEventListener('keydown', () => pinned.add(el), { passive: true, capture: true });
            el.addEventListener('pointerdown', (e) => {
                if (e.target === el) pinned.add(el); // scrollbar or empty strip
            }, { passive: true, capture: true });
            el.addEventListener('click', () => pinned.delete(el), { passive: true, capture: true });
        };

        const scan = () => {
            const thumb = document.getElementById('thumbnailList');
            if (thumb) install(thumb);
            document.querySelectorAll('.event-tab-scroll-pane').forEach(install);
        };
        scan();
        setTimeout(scan, 800);
        setTimeout(scan, 2500);

        let scheduled = false;
        const scanSoon = () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => { scheduled = false; scan(); }, 250);
        };
        try {
            new MutationObserver(scanSoon).observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }

        if (window.__PDL_HARNESS__) {
            window.__PDL_SCROLL_DEBUG__ = () => {
                const t = document.getElementById('thumbnailList');
                return {
                    installed: true,
                    page: true,
                    guarded: !!(t && guarded.has(t)),
                    desc: !!(t && Object.getOwnPropertyDescriptor(t, 'scrollLeft')),
                    pinned: !!(t && pinned.has(t))
                };
            };
        }
    }

    function sandboxScrollGuard() {
            if (!IS_TOP) return;
            const manual = new WeakMap();
            const WINDOW_MS = 6000;
            const mark = (el) => { if (el) manual.set(el, Date.now() + WINDOW_MS); };
            const isManual = (el) => (manual.get(el) || 0) > Date.now();
            const proto = (() => { try { return PAGE_WINDOW.Element.prototype; } catch (e) { return Element.prototype; } })();

            if (proto && !proto.__pdlScrollProtoHooked) {
                proto.__pdlScrollProtoHooked = true;
                const wrap = (name) => {
                    const original = proto[name];
                    if (typeof original !== 'function') return;
                    proto[name] = function () {
                        if (name === 'scrollIntoView') {
                            let node = this;
                            while (node) {
                                if (isManual(node)) return;
                                node = node.parentElement;
                            }
                        } else if (isManual(this)) {
                            return;
                        }
                        return original.apply(this, arguments);
                    };
                };
                wrap('scrollIntoView');
                wrap('scrollTo');
                wrap('scrollBy');
            }

            const guarded = new WeakSet();
            const install = (el) => {
                if (!el || guarded.has(el)) return;
                guarded.add(el);
                if (window.__PDL_HARNESS__) window.__PDL_INSTALL_COUNT__ = (window.__PDL_INSTALL_COUNT__ || 0) + 1;

                // Panopto animates scrollLeft/scrollTop with jQuery (scrollingHighlight),
                // one write per frame. Reverting after the fact loses that race, so
                // drop the writes while the user is the one scrolling.
                const guardProp = (prop) => {
                    let desc = null;
                    try { desc = Object.getOwnPropertyDescriptor(proto, prop); } catch (e) { /* ignore */ }
                    if (!desc || !desc.get || !desc.set) return;
                    try {
                        Object.defineProperty(el, prop, {
                            configurable: true,
                            get() { return desc.get.call(this); },
                            set(value) {
                                if (isManual(el)) return;
                                desc.set.call(this, value);
                            }
                        });
                    } catch (e) {
                        if (window.__PDL_HARNESS__) window.__PDL_GUARD_ERR__ = prop + ': ' + String(e);
                    }
                };
                guardProp('scrollLeft');
                guardProp('scrollTop');

                let userUntil = 0;
                const userScroll = () => {
                    userUntil = Date.now() + 350;
                    mark(el);
                    if (window.__PDL_HARNESS__) window.__PDL_WHEEL_MARKS__ = (window.__PDL_WHEEL_MARKS__ || 0) + 1;
                };
                el.__pdlUserScroll = userScroll;
                el.addEventListener('wheel', userScroll, { passive: true, capture: true });
                el.addEventListener('pointerdown', () => { userUntil = Date.now() + 500; mark(el); }, { passive: true, capture: true });
                el.addEventListener('touchstart', () => { userUntil = Date.now() + 500; mark(el); }, { passive: true, capture: true });
                el.addEventListener('keydown', () => userScroll(), { passive: true, capture: true });
            };

            const scan = () => {
                const thumb = document.getElementById('thumbnailList');
                if (thumb) install(thumb);
                document.querySelectorAll('.event-tab-scroll-pane').forEach(install);
            };
            scan();

            const markFromEvent = (e) => {
                if (window.__PDL_HARNESS__) window.__PDL_SCROLL_EVENTS__ = (window.__PDL_SCROLL_EVENTS__ || 0) + 1;
                const target = e.target && e.target.closest ? e.target.closest('#thumbnailList, .event-tab-scroll-pane') : null;
                if (target && target.__pdlUserScroll) target.__pdlUserScroll();
            };
            document.addEventListener('wheel', markFromEvent, { passive: true, capture: true });
            document.addEventListener('pointerdown', markFromEvent, { passive: true, capture: true });

            if (window.__PDL_HARNESS__) {
                window.__PDL_SCROLL_DEBUG__ = () => {
                    const t = document.getElementById('thumbnailList');
                    return {
                        installed: !!(t && guarded.has(t)),
                        hasUserScroll: !!(t && typeof t.__pdlUserScroll === 'function'),
                        installs: window.__PDL_INSTALL_COUNT__ || 0,
                        events: window.__PDL_SCROLL_EVENTS__ || 0,
                        marks: window.__PDL_WHEEL_MARKS__ || 0,
                        desc: !!(t && Object.getOwnPropertyDescriptor(t, 'scrollLeft')),
                        guardErr: window.__PDL_GUARD_ERR__ || null,
                        proto: !!proto.__pdlScrollProtoHooked,
                        manual: t ? isManual(t) : null,
                        siv: proto.scrollIntoView.toString().slice(0, 90)
                    };
                };
            }

            let timer = 0;
            new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(scan, 400);
            }).observe(document.body, { childList: true, subtree: true });
    
    }

    function injectPageScrollGuard() {
        const source = '(' + pageScrollGuard.toString() + ')();';
        const root = document.documentElement || document.head;
        if (!root) { setTimeout(injectPageScrollGuard, 50); return; }
        try {
            const script = document.createElement('script');
            script.textContent = source;
            root.appendChild(script);
            script.remove();
        } catch (e) { /* CSP or XML page: fall back to the sandbox guard */ }
    }

    function initScrollGuard() {
        if (!IS_TOP) return;
        injectPageScrollGuard();
        if (PAGE_WINDOW.__pdlScrollGuardInstalled) {
            try { console.info('[Panopto DL] scroll guard: page-context'); } catch (e) { /* ignore */ }
            return;
        }
        try { console.info('[Panopto DL] scroll guard: sandbox fallback'); } catch (e) { /* ignore */ }
        sandboxScrollGuard();
    }

    function injectSidebarButton() {
        if (!IS_TOP) return;
        const tabControl = document.getElementById('eventTabControl');
        if (!tabControl || document.getElementById('panopto-dl-sidebar-btn')) return;

        const btn = document.createElement('div');
        btn.id = 'panopto-dl-sidebar-btn';
        btn.className = 'event-tab-header';
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('aria-label', 'Open Panopto downloader');
        btn.innerHTML = '<span class="pdl-sb-text">Download</span><span class="pdl-sb-dot"></span>';

        const activate = (e) => {
            e.preventDefault();
            e.stopPropagation();
            UI.toggle();
        };
        btn.addEventListener('click', activate);
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') activate(e);
        });

        // Keep it at the end of the normal tabs, before Panopto's helper links.
        const anchor = document.getElementById('advancedEditorLink') || document.getElementById('eventsExpanderButton');
        tabControl.insertBefore(btn, anchor && anchor.parentElement === tabControl ? anchor : null);
    }

    function applyDarkMode(enabled) {
        document.body.classList.toggle('pdl-dark', !!enabled);
        store.set(K.dark, !!enabled);
    }

    /* ============================================================
       BOOT
       ============================================================ */

    // Inject styles immediately so the page does not flash light -> dark.
    addStyle(SITE_CSS + '\n' + UI_CSS);

    Player.init();

    ready(() => {
        if (!document.body) return;
        setAccentVars();
        applyDarkMode(store.get(K.dark, true));

        if (!IS_TOP) return;

        // Sidebar button: re-add it if Panopto re-renders the tab list.
        let injectTimer = 0;
        const scheduleInject = () => {
            if (injectTimer) return;
            injectTimer = setTimeout(() => {
                injectTimer = 0;
                injectSidebarButton();
            }, 120);
        };
        new MutationObserver(scheduleInject).observe(document.body, { childList: true, subtree: true });
        injectSidebarButton();

        UI.init();
        initScrollGuard();

        registerMenu('Open Panopto downloader', () => UI.toggle());
        registerMenu('Toggle dark mode', () => applyDarkMode(!document.body.classList.contains('pdl-dark')));
    });
})();
