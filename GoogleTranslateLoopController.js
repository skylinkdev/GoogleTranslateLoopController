// ==UserScript==
// @name         Google Translate 循环朗读
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  在 Google Translate 添加循环朗读按钮 (右侧悬浮按钮 / Ctrl+L 弹出界面)
// @author       You
// @match        https://translate.google.com/*
// @match        https://translate.google.com.hk/*
// @match        https://translate.google.co.jp/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    let isLooping        = false;
    let loopTimer        = null;
    let playbackSafetyTimer   = null;
    let resolvePlaybackWait   = null;
    let audioPlaybackHookInstalled = false;
    let loopRunId        = 0;
    let loopPhase        = 'idle';
    let controlPanel     = null;
    let playbackIntervalTime = 4000;   // 间隔播放时间：播放结束后等待多久再播放下一轮，单位毫秒
    let selectedButtonIndex = null;
    let speakButtons     = [];
    let floatingBtn      = null;
    let fabLabel         = null;

    console.log('[循环朗读] 脚本已加载');

    // ─── 注入 CSS（用 textContent，不触发 Trusted Types）─────────────────
    function injectStyles() {
        const s = document.createElement('style');
        s.textContent = [
            '@keyframes fab-pulse {',
            '  0%   { box-shadow: -3px 0 16px rgba(52,168,83,.45); }',
            '  50%  { box-shadow: -6px 0 28px rgba(52,168,83,.80); }',
            '  100% { box-shadow: -3px 0 16px rgba(52,168,83,.45); }',
            '}',
            '@keyframes panel-in {',
            '  from { opacity:0; transform:scale(.92) translateY(12px); }',
            '  to   { opacity:1; transform:scale(1)   translateY(0);    }',
            '}'
        ].join('\n');
        document.head.appendChild(s);
    }

    // ─── SVG 辅助（必须用 createElementNS，不能用 innerHTML）────────────
    function svgEl(tag, attrs) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        return el;
    }

    function buildLoopSVG() {
        const svg = svgEl('svg', { width:'22', height:'22', viewBox:'0 0 24 24', fill:'none' });
        svg.appendChild(svgEl('path', {
            d:'M17 2L21 6L17 10', stroke:'currentColor',
            'stroke-width':'2.2', 'stroke-linecap':'round', 'stroke-linejoin':'round'
        }));
        svg.appendChild(svgEl('path', {
            d:'M3 11V9a4 4 0 0 1 4-4h14', stroke:'currentColor',
            'stroke-width':'2.2', 'stroke-linecap':'round', 'stroke-linejoin':'round'
        }));
        svg.appendChild(svgEl('path', {
            d:'M7 22L3 18L7 14', stroke:'currentColor',
            'stroke-width':'2.2', 'stroke-linecap':'round', 'stroke-linejoin':'round'
        }));
        svg.appendChild(svgEl('path', {
            d:'M21 13v2a4 4 0 0 1-4 4H3', stroke:'currentColor',
            'stroke-width':'2.2', 'stroke-linecap':'round', 'stroke-linejoin':'round'
        }));
        svg.appendChild(svgEl('circle', { cx:'12', cy:'12', r:'2', fill:'currentColor' }));
        return svg;
    }

    // ─── 右侧悬浮按钮 ────────────────────────────────────────────────────
    function createFloatingButton() {
        const btn = document.createElement('button');
        btn.id = 'loop-fab';
        btn.title = '循环朗读（Ctrl+L）';
        btn.style.cssText = [
            'position:fixed', 'right:0', 'top:50%', 'transform:translateY(-50%)',
            'z-index:2147483647',
            'display:flex', 'flex-direction:column', 'align-items:center',
            'justify-content:center', 'gap:6px',
            'padding:14px 10px',
            'background:#1a73e8', 'color:white',
            'border:none', 'border-radius:12px 0 0 12px',
            'cursor:pointer',
            'box-shadow:-3px 0 16px rgba(26,115,232,.35)',
            'font-family:Arial,sans-serif', 'font-size:11px', 'font-weight:600',
            'letter-spacing:.5px',
            'transition:background .25s,box-shadow .25s',
            'width:58px', 'user-select:none', 'outline:none'
        ].join(';');

        btn.appendChild(buildLoopSVG());

        fabLabel = document.createElement('span');
        fabLabel.textContent = '循环朗读';
        fabLabel.style.cssText = [
            'writing-mode:vertical-rl', 'text-orientation:mixed',
            'transform:rotate(180deg)',
            'font-size:11px', 'font-weight:600', 'letter-spacing:1px', 'margin-top:2px'
        ].join(';');
        btn.appendChild(fabLabel);

        btn.addEventListener('mouseenter', () => {
            if (!isLooping) {
                btn.style.background = '#1557b0';
                btn.style.boxShadow  = '-4px 0 22px rgba(26,115,232,.55)';
            }
        });
        btn.addEventListener('mouseleave', () => {
            if (!isLooping) {
                btn.style.background = '#1a73e8';
                btn.style.boxShadow  = '-3px 0 16px rgba(26,115,232,.35)';
            }
        });
        btn.addEventListener('click', togglePanel);

        document.body.appendChild(btn);
        floatingBtn = btn;
        console.log('[循环朗读] 悬浮按钮已创建');
    }

    function updateFloatingButton() {
        if (!floatingBtn) return;
        if (isLooping) {
            floatingBtn.style.background  = '#34a853';
            floatingBtn.style.boxShadow   = '-3px 0 16px rgba(52,168,83,.45)';
            floatingBtn.style.animation   = 'fab-pulse 1.5s ease-in-out infinite';
            if (fabLabel) fabLabel.textContent = '朗读中…';
        } else {
            floatingBtn.style.background  = '#1a73e8';
            floatingBtn.style.boxShadow   = '-3px 0 16px rgba(26,115,232,.35)';
            floatingBtn.style.animation   = 'none';
            if (fabLabel) fabLabel.textContent = '循环朗读';
        }
    }

    // ─── 查找发音按钮 ────────────────────────────────────────────────────
    function findAllSpeakButtons() {
        let buttons = Array.from(document.querySelectorAll('button')).filter(b => {
            const lbl = b.getAttribute('aria-label') || '';
            return lbl.includes('Listen') || lbl.includes('听') || lbl.includes('朗读');
        });
        if (buttons.length === 0) {
            buttons = Array.from(document.querySelectorAll('button')).filter(b => {
                if (!b.querySelector('svg')) return false;
                const p = b.closest('[jsname]');
                return p && p.querySelector('[lang]');
            });
        }
        console.log('[循环朗读] 找到发音按钮:', buttons.length);
        return buttons;
    }

    function getButtonDescription(btn, index) {
        let lang = '';
        const p  = btn.closest('[jsname]');
        if (p) {
            const le = p.querySelector('[lang]');
            if (le) lang = le.getAttribute('lang') || '';
        }
        const lbl = (btn.getAttribute('aria-label') || '').toLowerCase();
        let pos = index === 0 ? '源语言' : '目标语言';
        if (lbl.includes('source')) pos = '源语言';
        if (lbl.includes('target')) pos = '目标语言';
        return pos + (lang ? ' (' + lang + ')' : '');
    }

    // ─── 控制面板 ────────────────────────────────────────────────────────
    function el(tag, css, text) {
        const e = document.createElement(tag);
        if (css)  e.style.cssText = css;
        if (text) e.textContent   = text;
        return e;
    }

    function createControlPanel() {
        const existing = document.getElementById('loop-control-panel');
        if (existing) existing.remove();

        speakButtons = findAllSpeakButtons();

        // 遮罩
        const overlay = el('div', [
            'display:none', 'position:fixed', 'top:0', 'left:0',
            'width:100%', 'height:100%', 'background:rgba(0,0,0,.45)',
            'z-index:2147483646', 'justify-content:center', 'align-items:center',
            'backdrop-filter:blur(3px)'
        ].join(';'));
        overlay.id = 'loop-control-panel';

        // 面板
        const panel = el('div', [
            'background:white', 'border-radius:18px', 'padding:32px',
            'box-shadow:0 20px 60px rgba(0,0,0,.25)',
            'min-width:460px', 'max-width:560px',
            'max-height:80vh', 'overflow-y:auto',
            'font-family:Arial,sans-serif',
            'animation:panel-in .22s cubic-bezier(.34,1.56,.64,1)'
        ].join(';'));

        // 标题
        panel.appendChild(el('h2', 'margin:0 0 20px;font-size:22px;color:#1a73e8;text-align:center;', '🔁 循环朗读控制'));

        // 状态
        const statusDiv = el('div', [
            'text-align:center', 'padding:13px', 'margin-bottom:22px',
            'border-radius:10px', 'font-size:15px', 'font-weight:600',
            'background:#f1f3f4', 'color:#5f6368',
            'transition:background .3s,color .3s'
        ].join(';'), '状态: 未启动');
        statusDiv.id = 'loop-status';
        panel.appendChild(statusDiv);

        // 发音按钮选区
        const selectSection = el('div', 'margin-bottom:22px;');
        selectSection.appendChild(el('label', [
            'display:block', 'margin-bottom:10px', 'font-size:13px',
            'color:#5f6368', 'font-weight:600',
            'text-transform:uppercase', 'letter-spacing:.5px'
        ].join(';'), '选择要循环朗读的发音按钮:'));

        if (speakButtons.length > 0) {
            speakButtons.forEach((btn, index) => {
                const row = el('div', [
                    'display:flex', 'align-items:center',
                    'padding:12px 14px', 'margin-bottom:8px',
                    'border:2px solid #e0e0e0', 'border-radius:10px',
                    'cursor:pointer', 'transition:border-color .2s,background .2s'
                ].join(';'));

                const radio = document.createElement('input');
                radio.type  = 'radio';
                radio.name  = 'speak-button';
                radio.value = index;
                radio.id    = 'speak-btn-' + index;
                radio.style.cssText = 'margin-right:12px;width:17px;height:17px;cursor:pointer;accent-color:#1a73e8;';

                if (index === 0 && selectedButtonIndex === null) {
                    radio.checked = true;
                    selectedButtonIndex = 0;
                    row.style.borderColor = '#1a73e8';
                    row.style.background  = '#e8f0fe';
                }

                radio.addEventListener('change', () => {
                    selectedButtonIndex = index;
                    document.querySelectorAll('#loop-control-panel [name="speak-button"]').forEach(r => {
                        r.parentElement.style.borderColor = r.checked ? '#1a73e8' : '#e0e0e0';
                        r.parentElement.style.background  = r.checked ? '#e8f0fe' : 'white';
                    });
                });

                const lbl = el('label',
                    'flex:1;font-size:14px;color:#202124;cursor:pointer;',
                    '按钮 ' + (index + 1) + ': ' + getButtonDescription(btn, index));
                lbl.htmlFor = 'speak-btn-' + index;

                const testBtn = el('button',
                    'padding:6px 13px;background:#f1f3f4;color:#5f6368;border:none;border-radius:6px;font-size:13px;cursor:pointer;transition:background .2s;',
                    '🔊 测试');
                testBtn.addEventListener('mouseenter', () => testBtn.style.background = '#e2e5ea');
                testBtn.addEventListener('mouseleave', () => testBtn.style.background = '#f1f3f4');
                testBtn.addEventListener('click', e => { e.stopPropagation(); btn.click(); });

                row.addEventListener('click', () => { radio.checked = true; radio.dispatchEvent(new Event('change')); });
                row.appendChild(radio);
                row.appendChild(lbl);
                row.appendChild(testBtn);
                selectSection.appendChild(row);
            });
        } else {
            selectSection.appendChild(el('div', [
                'padding:14px', 'background:#fef7e0', 'border-radius:8px',
                'color:#c5771a', 'font-size:14px', 'text-align:center'
            ].join(';'), '⚠️ 未找到发音按钮，请先输入文本进行翻译'));
        }
        panel.appendChild(selectSection);

        // 间隔播放时间
        const intervalDiv = el('div', 'margin-bottom:22px;');
        intervalDiv.appendChild(el('label', [
            'display:block', 'margin-bottom:8px', 'font-size:13px',
            'color:#5f6368', 'font-weight:600',
            'text-transform:uppercase', 'letter-spacing:.5px'
        ].join(';'), '间隔播放时间 (秒):'));

        const intervalInput = document.createElement('input');
        intervalInput.type  = 'number';
        intervalInput.id    = 'interval-input';
        intervalInput.value = playbackIntervalTime / 1000;
        intervalInput.min   = '1';
        intervalInput.max   = '60';
        intervalInput.style.cssText = [
            'width:100%', 'padding:10px 12px', 'border:2px solid #e0e0e0',
            'border-radius:8px', 'font-size:16px', 'box-sizing:border-box',
            'transition:border-color .2s', 'outline:none'
        ].join(';');
        intervalInput.addEventListener('focus', () => intervalInput.style.borderColor = '#1a73e8');
        intervalInput.addEventListener('blur',  () => intervalInput.style.borderColor = '#e0e0e0');
        intervalInput.addEventListener('change', e => {
            const v = parseInt(e.target.value) * 1000;
            if (v >= 1000 && v <= 60000) {
                playbackIntervalTime = v;
                updatePanelStatus();
            }
        });
        intervalDiv.appendChild(intervalInput);
        panel.appendChild(intervalDiv);

        // 按钮行
        const btnRow = el('div', 'display:flex;gap:10px;margin-bottom:14px;');

        const toggleBtn = el('button', [
            'flex:1', 'padding:14px 16px', 'background:#34a853', 'color:white',
            'border:none', 'border-radius:10px', 'font-size:15px', 'font-weight:700',
            'cursor:pointer', 'transition:background .2s,transform .15s'
        ].join(';'), '▶️ 开始循环');
        toggleBtn.id = 'toggle-button';
        toggleBtn.addEventListener('mouseenter', () => toggleBtn.style.transform = 'scale(1.02)');
        toggleBtn.addEventListener('mouseleave', () => toggleBtn.style.transform = 'scale(1)');
        toggleBtn.addEventListener('click', () => {
            if (speakButtons.length === 0) { alert('请先输入文本并翻译后再开始循环朗读'); return; }
            toggleLoop();
            updatePanelStatus();
            updateFloatingButton();
        });

        const refreshBtn = el('button', [
            'padding:14px 16px', 'background:#fbbc04', 'color:white',
            'border:none', 'border-radius:10px', 'font-size:15px', 'font-weight:700',
            'cursor:pointer', 'transition:background .2s,transform .15s'
        ].join(';'), '🔄 刷新');
        refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.background = '#f9ab00'; refreshBtn.style.transform = 'scale(1.02)'; });
        refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.background = '#fbbc04'; refreshBtn.style.transform = 'scale(1)'; });
        refreshBtn.addEventListener('click', () => { hidePanel(); setTimeout(showPanel, 100); });

        const closeBtn = el('button', [
            'flex:1', 'padding:14px 16px', 'background:#5f6368', 'color:white',
            'border:none', 'border-radius:10px', 'font-size:15px', 'font-weight:700',
            'cursor:pointer', 'transition:background .2s,transform .15s'
        ].join(';'), '✕ 关闭');
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#3c4043'; closeBtn.style.transform = 'scale(1.02)'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = '#5f6368'; closeBtn.style.transform = 'scale(1)'; });
        closeBtn.addEventListener('click', hidePanel);

        btnRow.appendChild(toggleBtn);
        btnRow.appendChild(refreshBtn);
        btnRow.appendChild(closeBtn);
        panel.appendChild(btnRow);

        panel.appendChild(el('div',
            'text-align:center;font-size:12px;color:#9aa0a6;margin-top:10px;',
            '右侧悬浮按钮 或 Ctrl+L 可随时打开此面板'));

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        return overlay;
    }

    // ─── 面板显示控制 ────────────────────────────────────────────────────
    function showPanel() {
        if (controlPanel) controlPanel.remove();
        controlPanel = createControlPanel();
        controlPanel.style.display = 'flex';
        updatePanelStatus();
    }
    function hidePanel() {
        if (controlPanel) controlPanel.style.display = 'none';
    }
    function togglePanel() {
        if (!controlPanel || controlPanel.style.display === 'none') showPanel();
        else hidePanel();
    }

    function updatePanelStatus() {
        const statusDiv  = document.getElementById('loop-status');
        const toggleBtn  = document.getElementById('toggle-button');
        if (!statusDiv || !toggleBtn) return;
        if (isLooping) {
            const desc = selectedButtonIndex !== null
                ? getButtonDescription(speakButtons[selectedButtonIndex], selectedButtonIndex)
                : '未选择';
            statusDiv.textContent        = '状态: 循环中 ✔  (' + desc + '，播放结束后等待 ' + (playbackIntervalTime / 1000) + ' 秒)';
            statusDiv.style.background   = '#e8f5e9';
            statusDiv.style.color        = '#34a853';
            toggleBtn.textContent        = '⏹️ 停止循环';
            toggleBtn.style.background   = '#ea4335';
        } else {
            statusDiv.textContent        = '状态: 未启动';
            statusDiv.style.background   = '#f1f3f4';
            statusDiv.style.color        = '#5f6368';
            toggleBtn.textContent        = '▶️ 开始循环';
            toggleBtn.style.background   = '#34a853';
        }
    }

    // ─── 循环逻辑 ────────────────────────────────────────────────────────
    function clearLoopTimer() {
        if (loopTimer) {
            clearTimeout(loopTimer);
            loopTimer = null;
        }
    }

    function installAudioPlaybackHook() {
        if (audioPlaybackHookInstalled) return;

        const contextConstructors = [window.AudioContext, window.webkitAudioContext].filter(Boolean);
        const hookedPrototypes = new Set();

        contextConstructors.forEach(ContextCtor => {
            const proto = ContextCtor && ContextCtor.prototype;
            if (!proto || hookedPrototypes.has(proto) || typeof proto.createBufferSource !== 'function') return;

            const originalCreateBufferSource = proto.createBufferSource;
            proto.createBufferSource = function (...args) {
                const source = originalCreateBufferSource.apply(this, args);

                source.addEventListener('ended', () => {
                    console.log('[循环朗读] 播放结束');
                    finishPlaybackWait();
                });

                return source;
            };

            hookedPrototypes.add(proto);
        });

        audioPlaybackHookInstalled = hookedPrototypes.size > 0;
        console.log(audioPlaybackHookInstalled ? '[循环朗读] Hook成功' : '[循环朗读] Hook失败：当前页面不支持 AudioContext');
    }

    function cleanupPlaybackWait() {
        if (playbackSafetyTimer) {
            clearTimeout(playbackSafetyTimer);
            playbackSafetyTimer = null;
        }
        resolvePlaybackWait = null;
        loopPhase = 'idle';
    }

    function finishPlaybackWait() {
        if (!resolvePlaybackWait) return;
        const resolve = resolvePlaybackWait;
        cleanupPlaybackWait();
        resolve();
    }

    function observePlaybackEnd() {
        cleanupPlaybackWait();
        installAudioPlaybackHook();

        return new Promise(resolve => {
            resolvePlaybackWait = resolve;
            loopPhase = 'waiting-audio-ended';

            // 兜底：如果 Google 页面没有触发 AudioBufferSourceNode ended，避免循环永久卡住。
            playbackSafetyTimer = setTimeout(finishPlaybackWait, 60000);
        });
    }

    function waitPlaybackInterval(runId) {
        return new Promise(resolve => {
            if (!isLooping || runId !== loopRunId) {
                resolve();
                return;
            }

            loopPhase = 'interval';
            loopTimer = setTimeout(() => {
                loopTimer = null;
                resolve();
            }, playbackIntervalTime);
        });
    }

    function clickSelectedSpeakButton() {
        if (selectedButtonIndex !== null && speakButtons[selectedButtonIndex]) {
            speakButtons[selectedButtonIndex].click();
            return true;
        }
        return false;
    }
    function toggleLoop() {
        isLooping = !isLooping;
        if (isLooping) startLoop(); else stopLoop();
    }

    async function runLoop(runId) {
        while (isLooping && runId === loopRunId) {
            const btn = selectedButtonIndex !== null ? speakButtons[selectedButtonIndex] : null;
            if (!btn || !document.contains(btn)) {
                stopLoop();
                updatePanelStatus();
                updateFloatingButton();
                return;
            }

            const playbackDone = observePlaybackEnd();
            loopPhase = 'clicking';
            if (!clickSelectedSpeakButton()) {
                stopLoop();
                updatePanelStatus();
                updateFloatingButton();
                return;
            }
            loopPhase = 'playing';

            await playbackDone;
            await waitPlaybackInterval(runId);
        }
    }

    function startLoop() {
        stopLoop(false);
        isLooping = true;
        loopRunId += 1;
        runLoop(loopRunId);
    }

    function stopLoop(updateState = true) {
        if (updateState) isLooping = false;
        loopRunId += 1;
        clearLoopTimer();
        cleanupPlaybackWait();
    }

    // ─── 事件绑定 ────────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 'l') { e.preventDefault(); togglePanel(); }
    });
    document.addEventListener('click', e => {
        if (e.target.id === 'loop-control-panel') hidePanel();
    });
    window.addEventListener('beforeunload', stopLoop);

    // ─── 初始化 ──────────────────────────────────────────────────────────
    injectStyles();
    installAudioPlaybackHook();
    createFloatingButton();
    console.log('[循环朗读] 初始化完成 — 右侧按钮 或 Ctrl+L 打开面板');
})();
