import {define} from "../../framework/require.js";

function readLogs() {
    return new Promise((resolve) => {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get(['mephisto_error_logs'], (res) => {
                    const arr = (res && res.mephisto_error_logs) ? res.mephisto_error_logs : [];
                    resolve(arr);
                });
            } else if (window && window.localStorage) {
                const arr = JSON.parse(localStorage.getItem('mephisto_error_logs') || '[]');
                resolve(arr);
            } else {
                resolve([]);
            }
        } catch (e) { resolve([]); }
    });
}

function clearLogs() {
    return new Promise((resolve) => {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.remove('mephisto_error_logs', () => resolve());
            } else {
                resolve();
            }
            if (window && window.localStorage) {
                localStorage.removeItem('mephisto_error_logs');
            }
        } catch (e) { resolve(); }
    });
}

function downloadLogs(logs) {
    const blob = new Blob([JSON.stringify(logs, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mephisto-error-logs-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function formatTs(ts) {
    try {
        const d = new Date(ts);
        return d.toLocaleString();
    } catch (e) { return String(ts); }
}

function applyFilters(logs, {level, fromTs, toTs, search}) {
    let out = (logs || []).slice().reverse();
    if (level && level !== 'all') {
        out = out.filter(l => (l.type || '').toLowerCase() === level.toLowerCase());
    }
    if (fromTs) {
        out = out.filter(l => (l.ts || 0) >= fromTs);
    }
    if (toTs) {
        out = out.filter(l => (l.ts || 0) <= toTs);
    }
    if (search) {
        const s = search.toLowerCase();
        out = out.filter(l => (l.message && l.message.toLowerCase().includes(s)) || (l.context && l.context.toLowerCase().includes(s)) || (l.stack && l.stack.toLowerCase().includes(s)));
    }
    return out;
}

define({
    title: 'Logs',
    page: {
        onInit() {
            const tableBody = document.querySelector('#logs-table tbody');
            const refreshBtn = document.getElementById('refresh-logs');
            const clearBtn = document.getElementById('clear-logs');
            const dlBtn = document.getElementById('download-logs');
            const levelSel = document.getElementById('filter-level');
            const fromInput = document.getElementById('filter-from');
            const toInput = document.getElementById('filter-to');
            const pageSizeSel = document.getElementById('page-size');
            const prevBtn = document.getElementById('prev-page');
            const nextBtn = document.getElementById('next-page');
            const pageInfo = document.getElementById('page-info');
            const autoCheckbox = document.getElementById('auto-refresh');
            const autoIntervalInput = document.getElementById('auto-interval');

            let allLogs = [];
            let filtered = [];
            let page = 1;

            async function loadAndRender() {
                allLogs = await readLogs();
                applyAndRender();
            }

            function applyAndRender() {
                const level = levelSel.value;
                const fromTs = fromInput.value ? new Date(fromInput.value).getTime() : null;
                const toTs = toInput.value ? new Date(toInput.value).getTime() : null;
                const search = (document.getElementById('filter-search') && document.getElementById('filter-search').value) ? document.getElementById('filter-search').value : '';
                filtered = applyFilters(allLogs, {level, fromTs, toTs, search});
                page = Math.max(1, page);
                renderPage();
            }

            function renderPage() {
                const pageSize = parseInt(pageSizeSel.value, 10) || 25;
                const total = filtered.length;
                const maxPage = Math.max(1, Math.ceil(total / pageSize));
                if (page > maxPage) page = maxPage;
                const start = (page - 1) * pageSize;
                const pageItems = filtered.slice(start, start + pageSize);

                tableBody.innerHTML = '';
                for (const item of pageItems) {
                    const tr = document.createElement('tr');
                    const tdTime = document.createElement('td');
                    tdTime.textContent = item.ts ? formatTs(item.ts) : '-';
                    const tdCtx = document.createElement('td');
                    tdCtx.textContent = item.context || '-';
                    const tdLevel = document.createElement('td');
                    tdLevel.textContent = item.type || '-';
                    const tdMsg = document.createElement('td');
                    tdMsg.textContent = item.message ? (item.message.length > 200 ? item.message.substring(0, 200) + '…' : item.message) : '';
                    const tdStack = document.createElement('td');
                    if (item.stack) {
                        const btn = document.createElement('a');
                        btn.href = '#';
                        btn.textContent = 'View';
                        btn.addEventListener('click', (e) => {
                            e.preventDefault();
                            const next = tr.nextSibling;
                            if (next && next.classList && next.classList.contains('expand-row')) {
                                if (next.style.display === 'table-row') {
                                    next.style.display = 'none';
                                    btn.textContent = 'View';
                                } else {
                                    next.style.display = 'table-row';
                                    btn.textContent = 'Hide';
                                }
                            }
                        });
                        tdStack.appendChild(btn);
                    } else {
                        tdStack.textContent = '';
                    }

                    tr.appendChild(tdTime);
                    tr.appendChild(tdCtx);
                    tr.appendChild(tdLevel);
                    tr.appendChild(tdMsg);
                    tr.appendChild(tdStack);
                    tableBody.appendChild(tr);
                    // expandable row for full stack/message/meta
                    const trExp = document.createElement('tr');
                    trExp.className = 'expand-row';
                    trExp.style.display = 'none';
                    const tdExp = document.createElement('td');
                    tdExp.colSpan = 5;
                    const pre = document.createElement('pre');
                    pre.textContent = '';
                    try {
                        const full = {
                            ts: item.ts,
                            context: item.context,
                            type: item.type,
                            message: item.message,
                            stack: item.stack,
                            meta: item.meta || null
                        };
                        pre.textContent = JSON.stringify(full, null, 2);
                    } catch (e) {
                        pre.textContent = item.stack || item.message || '';
                    }
                    tdExp.appendChild(pre);
                    trExp.appendChild(tdExp);
                    tableBody.appendChild(trExp);
                }

                pageInfo.textContent = `Page ${page} / ${maxPage} (${total} entries)`;
                prevBtn.disabled = (page <= 1);
                nextBtn.disabled = (page >= maxPage);
            }

            refreshBtn.addEventListener('click', (e) => { e.preventDefault(); loadAndRender(); });
            levelSel.addEventListener('change', () => { page = 1; applyAndRender(); });
            fromInput.addEventListener('change', () => { page = 1; applyAndRender(); });
            toInput.addEventListener('change', () => { page = 1; applyAndRender(); });
            pageSizeSel.addEventListener('change', () => { page = 1; renderPage(); });

            prevBtn.addEventListener('click', (e) => { e.preventDefault(); if (page > 1) { page--; renderPage(); } });
            nextBtn.addEventListener('click', (e) => { e.preventDefault(); page++; renderPage(); });

            clearBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                if (!confirm('Clear all stored error logs?')) return;
                await clearLogs();
                allLogs = [];
                filtered = [];
                page = 1;
                renderPage();
                M.toast({html: 'Logs cleared.'});
            });

            dlBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                // download currently filtered logs
                downloadLogs(filtered);
            });

            let pollTimer = null;
            function startAutoPoll() {
                stopAutoPoll();
                const interval = Math.max(5, parseInt(autoIntervalInput.value, 10) || 10) * 1000;
                pollTimer = setInterval(() => { loadAndRender(); }, interval);
            }
            function stopAutoPoll() {
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            }
            autoCheckbox.addEventListener('change', () => {
                if (autoCheckbox.checked) startAutoPoll(); else stopAutoPoll();
            });
            autoIntervalInput.addEventListener('change', () => { if (autoCheckbox.checked) startAutoPoll(); });

            // initial load
            M.FormSelect.init(document.querySelectorAll('select'), {});
            loadAndRender();
        }
    }
});
