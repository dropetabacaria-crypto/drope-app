// ============================================================
// Drope Feedback Bubble v2 — versão SIMPLES, sem drag, sem MutationObserver, sem backdrop fullscreen
//
// Por quê v2: a v1 tinha drag (pointer events com setPointerCapture) + MutationObserver no body inteiro
// + listeners globais que bloqueavam touch events em mobile (Chrome/MIUI). Bissecção provou que
// removendo essas features, a bolinha funciona limpa em qualquer dispositivo.
//
// O que MANTÉM: bolinha + menu inline + modal de reportar com screenshot.
// O que TIROU: drag (não era essencial), MutationObserver (admin check uma vez no init basta),
// backdrop fullscreen (substituído por click fora simples), listeners globais window.error.
// ============================================================
(function () {
  'use strict';
  if (window.__dropeFeedbackBubbleMounted) return;
  window.__dropeFeedbackBubbleMounted = true;

  const BUBBLE_ID = 'drope-fb-bubble';
  const MODAL_ID = 'drope-fb-modal';
  const MENU_ID = 'drope-fb-menu';

  function isAdminContext() {
    try { if (localStorage.getItem('drope_admin_token')) return true; } catch (e) {}
    const adminScreen = document.querySelector('.screen.active[id^="admin-"]:not(#admin-login)');
    return !!adminScreen;
  }

  function injectCSS() {
    if (document.getElementById('drope-fb-css')) return;
    const css = `
      #${BUBBLE_ID} {
        position: fixed;
        /* abaixo do header (60-70px) + 16px de respiro + safe-area-inset-top (notch) */
        top: calc(86px + env(safe-area-inset-top));
        right: 12px;
        width: 44px; height: 44px;
        border-radius: 50%;
        background: rgba(20,20,31,0.92);
        border: 2px solid #D4FF2E;
        color: #D4FF2E;
        display: none;
        align-items: center; justify-content: center;
        font-size: 20px;
        /* z-index 30: acima do conteúdo do app, ABAIXO de modais/overlays do app (40-100) */
        z-index: 30;
        cursor: pointer;
        touch-action: manipulation;
        box-shadow: 0 4px 18px rgba(212,255,46,0.35);
        font-family: inherit;
        padding: 0;
      }
      #${BUBBLE_ID}.show { display: flex; }
      #${BUBBLE_ID}:active { transform: scale(0.94); }

      #${MENU_ID} {
        position: fixed;
        z-index: 31;
        display: none;
        flex-direction: column;
        gap: 8px;
      }
      #${MENU_ID}.show { display: flex; }
      .drope-fb-mi {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px;
        background: rgba(20,20,31,0.95);
        border: 1px solid rgba(212,255,46,0.5);
        color: #EAEAF2;
        font-size: 13px; font-weight: 600;
        border-radius: 999px;
        cursor: pointer;
        touch-action: manipulation;
        font-family: inherit;
      }
      .drope-fb-mi:active { transform: scale(0.96); }
      .drope-fb-mi .ic { font-size: 16px; }

      #${MODAL_ID} {
        position: fixed; inset: 0;
        /* modal de feedback acima de qualquer modal do app (que usam até z-index 100) */
        z-index: 200;
        background: rgba(10,10,20,0.88);
        display: none; align-items: flex-end; justify-content: center;
      }
      #${MODAL_ID}.show { display: flex; }
      #${MODAL_ID} .fb-content {
        width: 100%; max-width: 480px; max-height: 92dvh;
        background: #14141F;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 18px 18px 0 0;
        padding: 18px 18px calc(18px + env(safe-area-inset-bottom));
        overflow-y: auto;
        color: #EAEAF2;
        font-family: inherit;
      }
      #${MODAL_ID} h3 { margin: 0 0 4px; font-size: 18px; }
      #${MODAL_ID} .fb-sub { color: #8A8AA3; font-size: 13px; margin: 0 0 14px; }
      #${MODAL_ID} .fb-preview {
        width: 100%; max-height: 240px; object-fit: contain;
        border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);
        background: #0A0A14; margin-bottom: 12px;
      }
      #${MODAL_ID} textarea {
        width: 100%; min-height: 80px;
        padding: 10px 12px;
        background: #0A0A14; border: 1px solid rgba(255,255,255,0.08);
        color: #EAEAF2; border-radius: 10px; font-size: 14px;
        font-family: inherit;
        resize: vertical;
        margin-bottom: 12px;
      }
      #${MODAL_ID} .fb-actions {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
      }
      #${MODAL_ID} .fb-btn {
        padding: 13px 14px; border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.08);
        background: #14141F; color: #EAEAF2;
        font-size: 14px; font-weight: 600; cursor: pointer;
        font-family: inherit; touch-action: manipulation;
      }
      #${MODAL_ID} .fb-btn-primary { background: #D4FF2E; color: #000; border-color: #D4FF2E; }
      #${MODAL_ID} .fb-btn-ghost { background: transparent; color: #8A8AA3; }
      #${MODAL_ID} .fb-status { font-size: 12px; color: #8A8AA3; margin-top: 8px; min-height: 16px; }
      #${MODAL_ID} .fb-status.ok { color: #D4FF2E; }
      #${MODAL_ID} .fb-status.err { color: #FF2D6F; }
    `;
    const style = document.createElement('style');
    style.id = 'drope-fb-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function injectDOM() {
    if (document.getElementById(BUBBLE_ID)) return;

    const bubble = document.createElement('button');
    bubble.id = BUBBLE_ID;
    bubble.type = 'button';
    bubble.title = 'menu';
    bubble.textContent = '📤';
    document.body.appendChild(bubble);

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.innerHTML = `
      <button type="button" class="drope-fb-mi" data-act="refresh"><span class="ic">🔄</span><span>atualizar</span></button>
      <button type="button" class="drope-fb-mi" data-act="report"><span class="ic">📤</span><span>reportar</span></button>
    `;
    document.body.appendChild(menu);

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="fb-content">
        <h3>📤 reportar pro Code</h3>
        <p class="fb-sub">screenshot + state da tela vai pro Claude Code revisar.</p>
        <img class="fb-preview" id="drope-fb-preview" alt="preview" />
        <textarea id="drope-fb-notes" placeholder="o que rolou? (opcional)"></textarea>
        <div class="fb-actions">
          <button type="button" class="fb-btn fb-btn-primary" id="drope-fb-send">enviar</button>
          <button type="button" class="fb-btn fb-btn-ghost" id="drope-fb-close">cancelar</button>
        </div>
        <div class="fb-status" id="drope-fb-status"></div>
      </div>
    `;
    document.body.appendChild(modal);

    bubble.addEventListener('click', toggleMenu);
    menu.addEventListener('click', (ev) => {
      const it = ev.target.closest('.drope-fb-mi');
      if (!it) return;
      const act = it.dataset.act;
      closeMenu();
      if (act === 'refresh') doRefresh();
      else if (act === 'report') openReport();
    });
    document.getElementById('drope-fb-close').addEventListener('click', closeModal);
    document.getElementById('drope-fb-send').addEventListener('click', sendFeedback);

    // Click fora do menu fecha (sem backdrop fullscreen — usa um listener no document só quando menu visível)
    document.addEventListener('click', (ev) => {
      if (!menu.classList.contains('show')) return;
      if (ev.target === bubble || bubble.contains(ev.target)) return;
      if (menu.contains(ev.target)) return;
      closeMenu();
    });
  }

  function positionMenu() {
    const bubble = document.getElementById(BUBBLE_ID);
    const menu = document.getElementById(MENU_ID);
    const rect = bubble.getBoundingClientRect();
    menu.style.top = (rect.bottom + 8) + 'px';
    menu.style.right = '12px';
    menu.style.left = 'auto';
  }

  function toggleMenu(ev) {
    const menu = document.getElementById(MENU_ID);
    if (menu.classList.contains('show')) {
      closeMenu();
    } else {
      positionMenu();
      menu.classList.add('show');
    }
    if (ev) ev.stopPropagation();
  }
  function closeMenu() {
    document.getElementById(MENU_ID).classList.remove('show');
  }

  function doRefresh() {
    try {
      const u = new URL(location.href);
      u.searchParams.set('_r', Date.now().toString(36));
      location.replace(u.toString());
    } catch (e) {
      location.reload();
    }
  }

  // ---------- html2canvas lazy load ----------
  let _h2cPromise = null;
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (_h2cPromise) return _h2cPromise;
    _h2cPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error('falha ao baixar html2canvas'));
      document.head.appendChild(s);
    });
    return _h2cPromise;
  }

  function captureState() {
    const state = {
      url: location.href,
      hash: location.hash,
      pathname: location.pathname,
      activeScreens: [],
    };
    document.querySelectorAll('.screen.active').forEach(s => state.activeScreens.push(s.id));
    try {
      if (window.state) state.appState = JSON.parse(JSON.stringify(window.state, replacerSafe));
    } catch (e) {}
    return state;
  }
  function replacerSafe(key, value) {
    if (key === 'stream' || key === 'capStream' || key === 'detector' || key === 'codeReader' || key === 'controls') return undefined;
    if (value instanceof Map) return '[Map size=' + value.size + ']';
    if (typeof value === 'function') return undefined;
    if (value && value.constructor && ['MediaStream', 'BarcodeDetector'].includes(value.constructor.name)) return undefined;
    return value;
  }

  let _capturedScreenshot = null;

  async function openReport() {
    document.getElementById('drope-fb-notes').value = '';
    document.getElementById('drope-fb-preview').src = '';
    setStatus('');
    document.getElementById(MODAL_ID).classList.add('show');
    const bubble = document.getElementById(BUBBLE_ID);
    setStatus('capturando tela…');
    try {
      bubble.style.opacity = '0';
      const h2c = await loadHtml2Canvas();
      const canvas = await h2c(document.body, {
        backgroundColor: '#0A0A14',
        scale: Math.min(2, (window.devicePixelRatio || 1)),
        logging: false,
        useCORS: true,
        ignoreElements: (el) => el.id === BUBBLE_ID || el.id === MODAL_ID || el.id === MENU_ID,
      });
      bubble.style.opacity = '';
      const MAX = 1280;
      let w = canvas.width, h = canvas.height;
      if (w > MAX) { h = Math.round(h * (MAX / w)); w = MAX; }
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').drawImage(canvas, 0, 0, w, h);
      _capturedScreenshot = tmp.toDataURL('image/png');
      document.getElementById('drope-fb-preview').src = _capturedScreenshot;
      setStatus('pronto pra enviar.');
    } catch (e) {
      bubble.style.opacity = '';
      _capturedScreenshot = null;
      setStatus('erro capturando: ' + e.message, 'err');
    }
  }

  function closeModal() {
    document.getElementById(MODAL_ID).classList.remove('show');
    _capturedScreenshot = null;
  }
  function setStatus(html, cls) {
    const el = document.getElementById('drope-fb-status');
    el.className = 'fb-status' + (cls ? ' ' + cls : '');
    el.textContent = html || '';
  }

  async function sendFeedback() {
    if (!_capturedScreenshot) {
      setStatus('aguarda a captura terminar', 'err');
      return;
    }
    const notes = document.getElementById('drope-fb-notes').value.trim();
    const state = captureState();
    setStatus('enviando…');
    try {
      const r = await fetch('/api/webhook?action=feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: location.href,
          userAgent: navigator.userAgent,
          viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
          state, notes,
          screenshotB64: _capturedScreenshot,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || ('http ' + r.status));
      setStatus('✅ enviado (' + data.id + ')', 'ok');
      setTimeout(closeModal, 1200);
    } catch (e) {
      setStatus('⚠️ erro: ' + e.message, 'err');
    }
  }

  function init() {
    injectCSS();
    injectDOM();
    // Admin context: checa UMA VEZ no init + reage a hashchange (mais leve que MutationObserver)
    function update() {
      const bubble = document.getElementById(BUBBLE_ID);
      if (!bubble) return;
      if (isAdminContext()) bubble.classList.add('show');
      else bubble.classList.remove('show');
    }
    update();
    window.addEventListener('hashchange', update);
    // Polling MUITO leve (5s) só pra cobrir mudanças de localStorage entre tabs
    setInterval(update, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
