// Background global error handlers — record and persist errors for debugging
(function () {
  function storeRecord(rec) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['mephisto_error_logs'], (res) => {
          const arr = (res && res.mephisto_error_logs) ? res.mephisto_error_logs : [];
          arr.push(rec);
          try { chrome.storage.local.set({ mephisto_error_logs: arr }); } catch (e) { }
        });
      }
    } catch (e) {
      console.error('background-script error storage failed', e);
    }
  }

  try {
    self.addEventListener && self.addEventListener('error', function (e) {
      const rec = {
        ts: Date.now(),
        context: 'background',
        type: 'error',
        message: e && e.message ? e.message : String(e),
        stack: e && e.error && e.error.stack ? e.error.stack : null
      };
      console.error('[Mephisto][background]', rec);
      storeRecord(rec);
    });
  } catch (e) { /* ignore */ }
})();

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if ((msg.from === 'content') && (msg.subject === 'showPageAction')) {
    chrome.pageAction.show(sender.tab.id);
  }
});


