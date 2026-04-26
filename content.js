// Bridge between web page and extension service worker.
// Web posts {source:'vp-web', reqId, payload} → extension processes → responds via window.postMessage.
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== 'vp-web') return;
  try {
    chrome.runtime.sendMessage(d.payload, (response) => {
      const lastError = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      window.postMessage(
        { source: 'vp-ext', reqId: d.reqId, response, lastError },
        '*'
      );
    });
  } catch (err) {
    window.postMessage(
      { source: 'vp-ext', reqId: d.reqId, response: null, lastError: err.message },
      '*'
    );
  }
});

// Notify the page that the extension is loaded.
window.postMessage({ source: 'vp-ext', type: 'READY' }, '*');
