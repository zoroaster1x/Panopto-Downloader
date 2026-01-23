// ==UserScript==
// @name         Panopto Video Downloader
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  A pretty simple Panopto video downloader userscript
// @author       Zoroaster1x
// @match        https://*.panopto.eu/Panopto/Pages/Viewer.aspx?*
// @match        https://*.panopto.com/Panopto/Pages/Viewer.aspx?*
// @match        https://*.panopto.eu/Panopto/Pages/Embed.aspx?*
// @match        https://*.panopto.com/Panopto/Pages/Embed.aspx?*
// @icon         https://www.panopto.com/wp-content/themes/panopto/library/images/favicons/favicon-96x96.png
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    /* History */
    const HISTORY_KEY = 'pdl_download_history_v3';
    const MAX_HISTORY = 20; // The number of downloads we'll remember in the history

    /* All the CSS for our fancy glassmorphic panel and buttons */
    GM_addStyle(`
        @import url('https://fonts.googleapis.com/icon?family=Material+Icons');

        #panopto-dl-sidebar-btn {
            cursor: pointer;
            display: flex;
            align-items: center;
            padding: 4px 0px 3px 8px !important;
            border-top: 1px solid rgba(0,0,0,0.05);
            color: #333;
            font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
            user-select: none;
            transition: background-color 0.1s;
        }
        #panopto-dl-sidebar-btn:hover { background-color: #f0f0f0; color: #21ce99; }
        #panopto-dl-sidebar-btn .material-icons {
            font-size: 20px;
            color: #21ce99;
            margin-right: 10px;
            width: 20px;
            text-align: center;
            margin-left: -3px;
        }
        #panopto-dl-sidebar-btn span.text {
            position: relative;
            top: 1px;
            left: -5px;
            font-size: 12px !important;
            font-weight: 600;
        }

        #pdl-panel {
            position: fixed;
            top: 15%;
            left: 20%;
            width: 450px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            z-index: 2147483647;
            background: rgba(35, 35, 40, 0.95);
            backdrop-filter: blur(15px);
            -webkit-backdrop-filter: blur(15px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            color: #eee;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            opacity: 0;
            transform: scale(0.95);
            pointer-events: none;
            transition: opacity 0.2s, transform 0.2s;
        }
        #pdl-panel.active { opacity: 1; transform: scale(1); pointer-events: all; }

        #pdl-header {
            padding: 15px 20px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
            background: rgba(255,255,255,0.03);
            border-radius: 12px 12px 0 0;
        }
        #pdl-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; color: #fff; }
        #pdl-close { background: none; border: none; color: rgba(255,255,255,0.4); cursor: pointer; font-size: 22px; line-height: 1; }
        #pdl-close:hover { color: #fff; }

        #pdl-tabs { display: flex; padding: 10px 20px 0; gap: 20px; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .pdl-tab { padding-bottom: 10px; font-size: 13px; color: rgba(255,255,255,0.5); cursor: pointer; position: relative; }
        .pdl-tab.active { color: #21ce99; font-weight: 500; }
        .pdl-tab.active::after { content: ''; position: absolute; bottom: -1px; left: 0; width: 100%; height: 2px; background: #21ce99; }

        #pdl-body { flex: 1; overflow-y: auto; padding: 20px; min-height: 150px; max-height: 400px; }
        .pdl-view { display: none; }
        .pdl-view.active { display: block; animation: fadeUp 0.3s ease; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

        .pdl-card {
            background: rgba(255,255,255,0.06);
            border-radius: 8px;
            padding: 12px 15px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid transparent;
            transition: background 0.2s;
        }
        .pdl-card:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.1); }
        .pdl-card-info h4 { margin: 0 0 3px 0; font-size: 14px; font-weight: 600; color: #fff; }
        .pdl-card-info p { margin: 0; font-size: 11px; color: rgba(255,255,255,0.6); }
        .pdl-tag { background: #333; color: #aaa; font-size: 9px; padding: 2px 4px; border-radius: 3px; margin-left: 6px; text-transform: uppercase; }

        .pdl-btn {
            width: 36px;
            height: 36px;
            border-radius: 8px;
            border: none;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            cursor: pointer;
            margin-left: 8px;
            transition: transform 0.1s;
            padding: 0 !important;
            box-sizing: border-box;
        }
        .pdl-btn:active { transform: scale(0.95); }
        .pdl-btn-icon { background: rgba(255,255,255,0.1); color: #ddd; }
        .pdl-btn-icon:hover { background: rgba(255,255,255,0.2); color: #fff; }
        .pdl-btn-primary { background: #21ce99; color: #fff !important; }
        .pdl-btn-primary:hover { background: #1cb585; box-shadow: 0 0 10px rgba(33, 206, 153, 0.4); }

        .pdl-btn i.material-icons {
            font-family: 'Material Icons' !important;
            font-weight: normal;
            font-style: normal;
            font-size: 20px !important;
            line-height: 1 !important;
            display: inline-block !important;
            color: inherit !important;
            width: auto !important;
            height: auto !important;
            opacity: 1 !important;
            visibility: visible !important;
            margin: 0 !important;
        }

        .pdl-hist-item { padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; margin-bottom: 8px; font-size: 12px; }
        .pdl-hist-row { display: flex; justify-content: space-between; margin-bottom: 4px; }
        .pdl-hist-title { font-weight: 600; color: #fff; max-width: 65%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .pdl-hist-date { color: #777; font-size: 10px; text-align: right; }
        .pdl-hist-url { color: #555; font-size: 10px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; margin-bottom: 6px; }
        .pdl-hist-footer { display: flex; flex-direction: column; gap: 4px; }
        .pdl-hist-status-text { font-weight: 600; font-size: 11px; }

        .pdl-progress-container { width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; margin-top: 2px; }
        .pdl-progress-bar { height: 100%; background: #21ce99; width: 0%; transition: width 0.2s linear; }
        .pdl-progress-bar.error { background: #e74c3c; }

        .status-downloading { color: #21ce99; }
        .status-complete { color: #2ecc71; }
        .status-error { color: #e74c3c; }
    `);

    let isPanelOpen = false;

    function init() {
        createPanel();

        // Keep an eye on the sidebar - Panopto sometimes re-renders it and removes our button
        new MutationObserver(() => {
            const tabControl = document.getElementById('eventTabControl');
            if (tabControl && !document.getElementById('panopto-dl-sidebar-btn')) {
                injectSidebarButton(tabControl);
            }
        }).observe(document.body, { childList: true, subtree: true });

        // Try adding the button right away if the sidebar already exists
        const tabControl = document.getElementById('eventTabControl');
        if (tabControl) injectSidebarButton(tabControl);
    }

    // Adds our download button to Panopto's sidebar
    function injectSidebarButton(parent) {
        const btn = document.createElement('div');
        btn.id = 'panopto-dl-sidebar-btn';
        btn.className = 'event-tab-header';
        btn.innerHTML = `<i class="material-icons">cloud_download</i><span class="text">Downloader</span>`;
        btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); togglePanel(); });
        parent.appendChild(btn);
    }

    // Builds the main floating panel with tabs and everything
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'pdl-panel';
        panel.innerHTML = `
            <div id="pdl-header">
                <div id="pdl-title"><i class="material-icons" style="color:#21ce99; margin-right:5px;">bolt</i> Panopto DL</div>
                <button id="pdl-close"><i class="material-icons">close</i></button>
            </div>
            <div id="pdl-tabs">
                <div class="pdl-tab active" data-target="view-streams">Streams</div>
                <div class="pdl-tab" data-target="view-history">Queue & History</div>
            </div>
            <div id="pdl-body">
                <div id="view-streams" class="pdl-view active"><div style="text-align:center; padding-top:20px; color:#888;">Initializing...</div></div>
                <div id="view-history" class="pdl-view"></div>
            </div>
        `;
        document.body.appendChild(panel);
        makeDraggable(panel);

        document.getElementById('pdl-close').addEventListener('click', togglePanel);

        // Wire up the tab switching
        panel.querySelectorAll('.pdl-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                panel.querySelectorAll('.pdl-tab').forEach(t => t.classList.remove('active'));
                panel.querySelectorAll('.pdl-view').forEach(v => v.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.target).classList.add('active');
                if (tab.dataset.target === 'view-history') renderHistory();
            });
        });
    }

    // Opens or closes the download panel
    function togglePanel() {
        isPanelOpen = !isPanelOpen;
        document.getElementById('pdl-panel').classList.toggle('active', isPanelOpen);
        if (isPanelOpen) fetchVideoData();
    }

    // Grabs the video info from Panopto's internal API
    async function fetchVideoData() {
        const view = document.getElementById('view-streams');
        const videoId = new URLSearchParams(window.location.search).get('id');

        if (!videoId) {
            view.innerHTML = `<div style="color:#e74c3c; text-align:center">Error: Video ID not found.</div>`;
            return;
        }

        try {
            const data = await getDeliveryInfo(videoId);
            renderStreams(data, view);
        } catch (e) {
            view.innerHTML = `<div style="color:#e74c3c; text-align:center">API Error: ${e.message}</div>`;
        }
    }

    // Makes the actual API request to get stream URLs
    function getDeliveryInfo(videoId) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: `${window.location.origin}/Panopto/Pages/Viewer/DeliveryInfo.aspx`,
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Accept": "application/json" },
                data: `deliveryId=${videoId}&isEmbed=true&responseType=json`,
                onload: (res) => {
                    if (res.status !== 200) return reject(new Error(res.status));
                    try { resolve(JSON.parse(res.responseText)); }
                    catch { reject(new Error("Invalid JSON")); }
                },
                onerror: () => reject(new Error("Network Error"))
            });
        });
    }

    // Shows all the available streams as nice clickable cards
    function renderStreams(data, container) {
        container.innerHTML = '';
        const title = data.Delivery?.SessionName || document.title;

        // Gather up all the streams we can find
        let streams = [];
        (data.Delivery?.PodcastStreams || []).forEach(s => streams.push({ name: 'Regular Download', url: s.StreamUrl }));
        (data.Delivery?.Streams || []).forEach(s => streams.push({ name: (!s.Tag || s.Tag === "Object") ? "Stream" : s.Tag, url: s.StreamUrl }));

        if (!streams.length) {
            container.innerHTML = '<div style="text-align:center; color:#888;">No streams found.</div>';
            return;
        }

        // When there's multiple streams with the same name, add numbers so you can tell them apart
        const nameCounts = {}, currentCounts = {};
        streams.forEach(s => nameCounts[s.name] = (nameCounts[s.name] || 0) + 1);
        streams = streams.map(s => {
            if (nameCounts[s.name] > 1) {
                currentCounts[s.name] = (currentCounts[s.name] || 0) + 1;
                return { ...s, name: `${s.name} ${currentCounts[s.name]}` };
            }
            return s;
        });

        // Put the video title at the top
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom:15px; color:#fff; font-weight:600; font-size:14px;';
        header.innerText = title;
        container.appendChild(header);

        // Build a card for each stream
        const cleanTitle = title.replace(/[\\/:*?"<>|]/g, '_').trim();
        streams.forEach(stream => {
            const isHLS = stream.url.includes('.m3u8');
            const ext = isHLS ? 'm3u8' : 'mp4';
            const fileName = `${cleanTitle} - ${stream.name}.${ext}`;

            const card = document.createElement('div');
            card.className = 'pdl-card';
            card.innerHTML = `
                <div class="pdl-card-info">
                    <h4>${stream.name} <span class="pdl-tag">${ext.toUpperCase()}</span></h4>
                    <p>${isHLS ? 'Stream URL (Requires VLC)' : 'Direct MP4 File'}</p>
                </div>
                <div style="display:flex; align-items:center">
                    <button class="pdl-btn pdl-btn-icon btn-copy" title="Copy Link"><i class="material-icons">content_copy</i></button>
                    ${!isHLS ? `<button class="pdl-btn pdl-btn-primary btn-download" title="Download"><i class="material-icons">download</i></button>` : ''}
                </div>
            `;
            container.appendChild(card);

            // Copy the URL when they click the copy button
            card.querySelector('.btn-copy').addEventListener('click', function() {
                GM_setClipboard(stream.url);
                const icon = this.querySelector('i');
                icon.innerText = 'check';
                setTimeout(() => icon.innerText = 'content_copy', 1000);
            });

            // Start the download when they click download
            const dlBtn = card.querySelector('.btn-download');
            if (dlBtn) dlBtn.addEventListener('click', () => startDownload(fileName, stream.url));
        });
    }

    // Kicks off a download and adds it to the history queue
    function startDownload(filename, url) {
        const historyItem = { id: Date.now(), title: filename, url, date: new Date().toLocaleString(), status: 'downloading', progress: 0, error: null };

        // Save it to history right away so it shows up in the queue
        const history = GM_getValue(HISTORY_KEY, []);
        history.unshift(historyItem);
        if (history.length > MAX_HISTORY) history.pop();
        GM_setValue(HISTORY_KEY, history);

        // Actually start downloading with progress updates
        GM_download({
            url, name: filename, saveAs: true,
            onprogress: (p) => updateStatus(historyItem.id, 'downloading', null, p.total > 0 ? Math.floor((p.loaded / p.total) * 100) : 0),
            onload: () => updateStatus(historyItem.id, 'complete', null, 100),
            onerror: (err) => updateStatus(historyItem.id, 'error', err.error || 'Failed', 0)
        });

        // Switch to the history tab so they can see the progress
        document.querySelector('.pdl-tab[data-target="view-history"]').click();
    }

    // Updates a download's status in storage and refreshes the UI
    function updateStatus(id, status, errorMsg, percentage) {
        const history = GM_getValue(HISTORY_KEY, []);
        const item = history.find(x => x.id === id);
        if (!item) return;

        item.status = status;
        if (errorMsg) item.error = errorMsg;
        if (percentage !== undefined) item.progress = percentage;
        GM_setValue(HISTORY_KEY, history);

        // Update the progress bar if this item is visible on screen
        const domItem = document.getElementById(`hist-item-${id}`);
        if (!domItem) return;

        const statusText = domItem.querySelector('.pdl-hist-status-text');
        const bar = domItem.querySelector('.pdl-progress-bar');

        if (status === 'downloading') {
            statusText.innerHTML = `<span class="status-downloading">Downloading ${percentage}%</span>`;
            bar.style.width = `${percentage}%`;
        } else if (status === 'complete') {
            statusText.innerHTML = `<span class="status-complete">Completed</span>`;
            bar.style.width = '100%';
        } else {
            statusText.innerHTML = `<span class="status-error">Error: ${errorMsg}</span>`;
            bar.classList.add('error');
            bar.style.width = '100%';
        }
    }

    // Displays the download history list
    function renderHistory() {
        const container = document.getElementById('view-history');
        const history = GM_getValue(HISTORY_KEY, []);
        container.innerHTML = '';

        if (!history.length) {
            container.innerHTML = '<div style="text-align:center; color:#777; margin-top:20px">History is empty.</div>';
            return;
        }

        // Little button to wipe the history clean
        const clearBtn = document.createElement('div');
        clearBtn.innerText = "Clear History";
        clearBtn.style.cssText = "text-align:right; font-size:11px; color:#aaa; cursor:pointer; margin-bottom:10px;";
        clearBtn.onclick = () => { GM_setValue(HISTORY_KEY, []); renderHistory(); };
        container.appendChild(clearBtn);

        // Render each download entry
        history.forEach(item => {
            let statusHtml, progressWidth = item.progress || 0, barClass = 'pdl-progress-bar';

            if (item.status === 'downloading') {
                statusHtml = `<span class="status-downloading">Downloading ${progressWidth}%</span>`;
            } else if (item.status === 'complete') {
                statusHtml = `<span class="status-complete">Completed</span>`;
                progressWidth = 100;
            } else {
                statusHtml = `<span class="status-error">Error: ${item.error || 'Failed'}</span>`;
                progressWidth = 100;
                barClass += ' error';
            }

            const div = document.createElement('div');
            div.className = 'pdl-hist-item';
            div.id = `hist-item-${item.id}`;
            div.innerHTML = `
                <div class="pdl-hist-row">
                    <div class="pdl-hist-title" title="${item.title}">${item.title}</div>
                    <div class="pdl-hist-date">${item.date}</div>
                </div>
                <div class="pdl-hist-url" title="${item.url}">${item.url}</div>
                <div class="pdl-hist-footer">
                    <div class="pdl-hist-status-text">${statusHtml}</div>
                    <div class="pdl-progress-container"><div class="${barClass}" style="width: ${progressWidth}%"></div></div>
                </div>
            `;
            container.appendChild(div);
        });
    }

    // Lets you drag the panel around by its header
    function makeDraggable(panel) {
        const header = document.getElementById('pdl-header');
        if (!header) return;

        header.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX, startY = e.clientY;
            const startLeft = panel.offsetLeft, startTop = panel.offsetTop;

            const onMove = (e) => {
                panel.style.left = (startLeft + e.clientX - startX) + 'px';
                panel.style.top = (startTop + e.clientY - startY) + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // Fire it up when the page is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();