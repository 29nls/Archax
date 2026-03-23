// Central error logging utility for extension pages (popup/options)
export function initGlobalErrorHandlers(contextName = 'unknown') {
    function storeRecord(rec) {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get(['mephisto_error_logs'], (res) => {
                    const arr = (res && res.mephisto_error_logs) ? res.mephisto_error_logs : [];
                    arr.push(rec);
                    try { chrome.storage.local.set({ mephisto_error_logs: arr }); } catch (e) { /* ignore */ }
                });
            } else if (window && window.localStorage) {
                const key = 'mephisto_error_logs';
                const arr = JSON.parse(localStorage.getItem(key) || '[]');
                arr.push(rec);
                localStorage.setItem(key, JSON.stringify(arr));
            }
        } catch (e) {
            console.error('ErrorLogger.storeRecord failed', e);
        }
    }

    function _log(rec) {
        try {
            console.error(`[Mephisto][${contextName}]`, rec);
            storeRecord(rec);
        } catch (e) {
            // best-effort
            console.error('ErrorLogger._log failed', e);
        }
    }

    window.onerror = function (message, source, lineno, colno, error) {
        const rec = {
            ts: Date.now(),
            context: contextName,
            type: 'error',
            message: message?.toString?.() || String(message),
            source: source || null,
            lineno: lineno || null,
            colno: colno || null,
            stack: error && error.stack ? error.stack : null
        };
        _log(rec);
        return false;
    };

    window.onunhandledrejection = function (event) {
        const reason = event && event.reason;
        const rec = {
            ts: Date.now(),
            context: contextName,
            type: 'unhandledrejection',
            message: (reason && reason.message) ? reason.message : String(reason),
            stack: (reason && reason.stack) ? reason.stack : null
        };
        _log(rec);
    };
}

export function logError(errorLike, meta = {}) {
    const rec = {
        ts: Date.now(),
        context: meta.context || 'manual',
        type: meta.type || 'error',
        message: (errorLike && errorLike.message) ? errorLike.message : String(errorLike),
        stack: (errorLike && errorLike.stack) ? errorLike.stack : null,
        meta: meta
    };
    try {
        console.error('[Mephisto][logError]', rec);
    } catch (e) {}
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['mephisto_error_logs'], (res) => {
                const arr = (res && res.mephisto_error_logs) ? res.mephisto_error_logs : [];
                arr.push(rec);
                try { chrome.storage.local.set({ mephisto_error_logs: arr }); } catch (e) { /* ignore */ }
            });
        } else if (window && window.localStorage) {
            const key = 'mephisto_error_logs';
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            arr.push(rec);
            localStorage.setItem(key, JSON.stringify(arr));
        }
    } catch (e) {
        console.error('ErrorLogger.logError failed', e);
    }
}

// Expose on window for non-module consumers
try { if (typeof window !== 'undefined') window.ErrorLogger = { initGlobalErrorHandlers, logError }; } catch (e) {}
