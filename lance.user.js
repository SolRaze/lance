// ==UserScript==
// @name         lance
// @namespace    https://github.com/SolRaze/lance
// @version      0.0.3
// @description  AI chat toolkit — export, Obsidian sync, Enter-as-newline, Caveman mode, settings dashboard
// @author       SolRaze
// @homepageURL  https://github.com/SolRaze/lance
// @supportURL   https://github.com/SolRaze/lance/issues
// @downloadURL  https://github.com/SolRaze/lance/releases/latest/download/lance.user.js
// @updateURL    https://github.com/SolRaze/lance/releases/latest/download/lance.user.js
// @license      MIT
// @include      *://chatgpt.com/*
// @include      *://grok.com/*
// @include      *://gemini.google.com/*
// @include      *://claude.ai/*
// @include      *://chat.deepseek.com/*
// @include      *://deepseek.com/*
// @include      *://yuanbao.tencent.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    'use strict';

    // ─── Platform ────────────────────────────────────────────────────────────────
    const host = window.location.hostname;
    const P =
        host.includes("chatgpt.com")         ? "chatGPT"  :
        host.includes("grok.com")            ? "grok"     :
        host.includes("gemini.google.com")   ? "gemini"   :
        host.includes("claude.ai")           ? "claude"   :
        host.includes("deepseek.com")        ? "deepseek" :
        host.includes("yuanbao.tencent.com") ? "yuanbao"  : "unknown";

    // ─── Helpers ─────────────────────────────────────────────────────────────────
    const qs  = (sel, root = document) => root.querySelector(sel);
    const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
    function mkEl(tag, opts = {}) {
        const el = document.createElement(tag);
        if (opts.html)      el.innerHTML   = opts.html;
        if (opts.text)      el.textContent = opts.text;
        if (opts.className) el.className   = opts.className;
        if (opts.style)     Object.assign(el.style, opts.style);
        return el;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SETTINGS
    // ═══════════════════════════════════════════════════════════════════════════
    const DEFAULTS = {
        sites:         { chatGPT: true, grok: true, gemini: true, claude: true, deepseek: true, yuanbao: true },
        shortcuts:     { ctrl: true, meta: true, alt: false },
        obsFolder:     "Chat",
        obsTabCloseMs: 1500,
        caveman:       { enabled: false, level: 'ultra' },
    };

    function loadCfg() {
        try {
            const s = GM_getValue("lance_cfg");
            if (s) {
                const parsed = JSON.parse(s);
                // Deep merge so nested objects (sites, shortcuts, caveman) don't lose keys
                return {
                    sites:         Object.assign({}, DEFAULTS.sites,     parsed.sites     || {}),
                    shortcuts:     Object.assign({}, DEFAULTS.shortcuts,  parsed.shortcuts  || {}),
                    obsFolder:     parsed.obsFolder     ?? DEFAULTS.obsFolder,
                    obsTabCloseMs: parsed.obsTabCloseMs ?? DEFAULTS.obsTabCloseMs,
                    caveman:       Object.assign({}, DEFAULTS.caveman,   parsed.caveman   || {}),
                };
            }
        } catch(_) {}
        return JSON.parse(JSON.stringify(DEFAULTS));
    }
    function saveCfg(c) { GM_setValue("lance_cfg", JSON.stringify(c)); }
    let CFG = loadCfg();

    // ═══════════════════════════════════════════════════════════════════════════
    //  CAVEMAN MODE
    // ═══════════════════════════════════════════════════════════════════════════
    // Format: instruction \n\n---\n\n <user text>
    // The --- is a separator BETWEEN the instruction and the user's message.
    // It must NOT trail after the user text — that caused the empty-send bug.
    const CAVEMAN_PROMPTS = {
        lite:  `[Caveman lite] Respond without filler or hedging. Keep full sentences and articles. Professional but tight. No pleasantries.\n\n---\n\n`,
        full:  `[Caveman full] Respond terse like smart caveman. Drop articles, fragments OK, short synonyms. Technical terms exact. Code blocks unchanged.\n\n---\n\n`,
        ultra: `[Caveman ultra] CAVEMAN ULTRA. Maximum compression. Short phrases. No filler. No intro/outro. No repetition. Keep all technical facts. Preserve code, commands, errors, paths, names, URLs, numbers, and API names exactly. Use compact bullets. Do not omit important warnings.\n\n---\n\n`,
    };

    function getChatInput() {
        if (P === "chatGPT")  return qs('#prompt-textarea');
        if (P === "claude")   return qs('div.ProseMirror') || qs('[contenteditable="true"][data-placeholder]');
        if (P === "gemini")   return qs('rich-textarea .ql-editor') || qs('div[contenteditable="true"]');
        if (P === "deepseek") return qs('textarea#chat-input') || qs('textarea');
        if (P === "grok")     return qs('textarea');
        if (P === "yuanbao")  return qs('textarea');
        return qs('textarea') || qs('div[contenteditable="true"]');
    }

    // Returns raw text content of the input, trimmed.
    // el.innerText on empty ProseMirror returns "\n" — must trim + length check.
    function getInputText(el) {
        return (el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '')).trim();
    }

    // Prepend prefix to input.
    // Textarea: uses native HTMLTextAreaElement value setter so React synthetic
    //   events fire correctly (plain el.value= doesn't trigger React's onChange).
    // Contenteditable: moves caret to position 0 of first text node,
    //   then execCommand('insertText') — the only reliable way to mutate
    //   ProseMirror/Quill without corrupting their internal document model.
    //   Falls back to DataTransfer paste simulation if execCommand blocked.
    function prependToInput(el, prefix) {
        el.focus();
        if (el.tagName === 'TEXTAREA') {
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            )?.set;
            const cur = el.value;
            if (nativeSetter) nativeSetter.call(el, prefix + cur);
            else el.value = prefix + cur;
            el.selectionStart = el.selectionEnd = prefix.length;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        } else {
            // Walk to first text node for correct range.setStart
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const firstText = walker.nextNode();
            const sel = window.getSelection();
            if (!sel) return;
            const range = document.createRange();
            if (firstText) {
                range.setStart(firstText, 0);
            } else {
                range.setStart(el, 0);
            }
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);

            const ok = document.execCommand('insertText', false, prefix);
            if (!ok) {
                // DataTransfer paste — triggers framework paste handlers
                try {
                    const dt = new DataTransfer();
                    dt.setData('text/plain', prefix);
                    el.dispatchEvent(new ClipboardEvent('paste', {
                        clipboardData: dt, bubbles: true, cancelable: true
                    }));
                } catch(_) {
                    // Absolute last resort
                    el.textContent = prefix + (el.textContent || '');
                    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
                }
            }
        }
    }

    // Inject caveman prefix if active and input is non-empty and not already injected.
    // Returns true if injection happened (caller may need to re-fire submit).
    function applyCavemanIfActive() {
        if (!CFG.caveman?.enabled) return false;
        const el = getChatInput();
        if (!el) return false;
        const cur = getInputText(el);
        if (!cur) return false;                        // empty input — don't inject
        if (cur.startsWith('[Caveman')) return false;  // already injected
        prependToInput(el, CAVEMAN_PROMPTS[CFG.caveman.level || 'ultra']);
        return true;
    }

    // ── Caveman button — identical interaction model to export box ───────────────
    // Draggable pill. Click opens menu: toggle on/off + 3 level items.
    // No long-press, no mouseover modes — pure click-to-open-menu.
    let cavemanBox = null;

    function updateCavemanPill() {
        if (!cavemanBox) return;
        const on  = CFG.caveman?.enabled;
        const lvl = (CFG.caveman?.level || 'ultra').toUpperCase();
        const label = cavemanBox.querySelector('#lance-cave-label');
        if (label) label.textContent = on ? `◈ ${lvl}` : '◈ CAVE';
        // Active = white bg + dark text  |  inactive = dark ghost (same as export box)
        cavemanBox.style.background = on
            ? 'rgba(255,255,255,0.92)'
            : 'rgba(24,24,27,0.9)';
        cavemanBox.style.color = on ? '#111' : 'rgba(255,255,255,0.85)';
        cavemanBox.style.boxShadow = on
            ? '0 4px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.2)'
            : '0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.07)';
    }

    function initCavemanPill() {
        if (qs('#lance-cave-box')) { updateCavemanPill(); return; }

        // Outer draggable box — same class as export box for identical appearance
        const box = mkEl('div', { className: 'ai-export-drag-box' });
        box.id = 'lance-cave-box';
        box.innerHTML = `<div style="display:flex;align-items:center;gap:7px;pointer-events:none;">
            <span id="lance-cave-label" style="font-size:13px;font-weight:700;letter-spacing:0.05em">◈ CAVE</span>
        </div>`;

        // Menu panel — same class as export menu
        const menu = mkEl('div', { className: 'ai-export-menu-panel' });

        // Helper: menu button (reuse same pattern as export box)
        const mBtn = (label, badge, fn) => {
            const btn = mkEl('button', { className: 'ai-export-menu-item' });
            btn.innerHTML = `<span style="flex:1">${label}</span><span class="ai-export-badge">${badge}</span>`;
            btn.onclick = e => {
                e.stopPropagation();
                btn.classList.add('clicked');
                setTimeout(() => { btn.classList.remove('clicked'); menu.style.display = 'none'; fn(); }, 160);
            };
            return btn;
        };

        // Section label
        const secLabel = mkEl('div', { className: 'ai-export-section-label', text: 'Caveman Mode' });
        menu.appendChild(secLabel);

        // Toggle row
        const toggleBtn = mkEl('button', { className: 'ai-export-menu-item' });
        const updateToggleBtn = () => {
            const on = CFG.caveman?.enabled;
            toggleBtn.innerHTML = `<span style="flex:1">${on ? 'Enabled' : 'Disabled'}</span><span class="ai-export-badge">${on ? 'ON' : 'OFF'}</span>`;
        };
        updateToggleBtn();
        toggleBtn.onclick = e => {
            e.stopPropagation();
            if (!CFG.caveman) CFG.caveman = { enabled: false, level: 'ultra' };
            CFG.caveman.enabled = !CFG.caveman.enabled;
            saveCfg(CFG); updateCavemanPill(); updateToggleBtn();
        };
        menu.appendChild(toggleBtn);

        // Divider + level section
        menu.appendChild(mkEl('div', { className: 'ai-export-menu-divider' }));
        menu.appendChild(mkEl('div', { className: 'ai-export-section-label', text: 'Level' }));

        const LEVELS = [
            ['lite',  'Lite',  'Tight prose, no filler'],
            ['full',  'Full',  'Terse, fragments OK'],
            ['ultra', 'Ultra', 'Max compression'],
        ];
        LEVELS.forEach(([val, name, desc]) => {
            const btn = mkEl('button', { className: 'ai-export-menu-item' });
            const updateActive = () => {
                const active = (CFG.caveman?.level || 'ultra') === val;
                btn.innerHTML = `<span style="flex:1">${name}<span style="display:block;font-size:10px;opacity:0.45;font-weight:400">${desc}</span></span><span class="ai-export-badge">${active ? '●' : ''}</span>`;
                btn.style.color = active ? '#fff' : '';
            };
            updateActive();
            btn.onclick = e => {
                e.stopPropagation();
                if (!CFG.caveman) CFG.caveman = { enabled: false, level: 'ultra' };
                CFG.caveman.level = val;
                saveCfg(CFG); updateCavemanPill();
                // refresh all level buttons
                menu.querySelectorAll('.cave-lvl-btn').forEach(b => b._refresh?.());
                menu.style.display = 'none';
            };
            btn._refresh = updateActive;
            btn.classList.add('cave-lvl-btn');
            menu.appendChild(btn);
        });

        box.appendChild(menu);
        document.body.appendChild(box);
        cavemanBox = box;

        // Position (saved separately from export box)
        const sx = GM_getValue('cx', window.innerWidth  - 160);
        const sy = GM_getValue('cy', window.innerHeight - 55);
        box.style.left = Math.max(0, Math.min(sx, window.innerWidth  - 120)) + 'px';
        box.style.top  = Math.max(0, Math.min(sy, window.innerHeight -  40)) + 'px';
        updateCavemanPill();

        // Drag — exact same pattern as export box
        let drag = false, moved = false, dX0, dY0, iL, iT;
        box.onmousedown = e => { drag=true; moved=false; dX0=e.clientX; dY0=e.clientY; iL=box.offsetLeft; iT=box.offsetTop; e.preventDefault(); };
        document.addEventListener('mousemove', e => {
            if (!drag) return;
            const dx=e.clientX-dX0, dy=e.clientY-dY0;
            if (Math.abs(dx)>3||Math.abs(dy)>3) moved=true;
            box.style.left=(iL+dx)+'px'; box.style.top=(iT+dy)+'px';
        });
        document.addEventListener('mouseup', () => {
            if (drag&&moved) { GM_setValue('cx',box.offsetLeft); GM_setValue('cy',box.offsetTop); }
            drag=false;
        });

        // Click to open/close menu — exact same pattern as export box
        box.onclick = () => {
            if (moved) return;
            if (menu.style.display !== 'flex') {
                const rect=box.getBoundingClientRect(), isB=rect.top>window.innerHeight/2, isR=rect.left>window.innerWidth/2;
                menu.className = 'ai-export-menu-panel';
                menu.classList.add(isB ? isR ? 'pos-bottom-right':'pos-bottom-left' : isR ? 'pos-top-right':'pos-top-left');
                // Refresh level active states on open
                menu.querySelectorAll('.cave-lvl-btn').forEach(b => b._refresh?.());
                updateToggleBtn();
                menu.style.display = 'flex';
            } else {
                menu.style.display = 'none';
            }
        };
        document.addEventListener('click', e => { if (!cavemanBox?.contains(e.target)) menu.style.display='none'; });

        // ── Mouse-click send intercept ───────────────────────────────────────────
        // MUST use capture phase + preventDefault to stop the site's handler firing
        // before the DOM update from prependToInput is processed.
        // After injection, re-fire sb.click() in a 30ms timeout so the framework
        // (React/ProseMirror) has time to reconcile the new input value.
        document.addEventListener('click', e => {
            if (!CFG.caveman?.enabled) return;
            const sb = findSubmit();
            if (!sb) return;
            if (!(e.target === sb || sb.contains(e.target))) return;
            // If already injected, let the click proceed normally
            const el = getChatInput();
            if (!el) return;
            const cur = getInputText(el);
            if (!cur || cur.startsWith('[Caveman')) return;
            // Block original click, inject, re-fire
            e.preventDefault();
            e.stopImmediatePropagation();
            applyCavemanIfActive();
            setTimeout(() => sb.click(), 30);
        }, true); // capture phase — fires before site handlers
    }

    // ─── Filename ────────────────────────────────────────────────────────────────
    function makeFilename(title, turnCount) {
        const d = new Date();
        const date = d.getFullYear().toString()
                   + String(d.getMonth() + 1).padStart(2, "0")
                   + String(d.getDate()).padStart(2, "0");
        return `${date}${String(turnCount).padStart(4, "0")}_${title}`;
    }

    function sanitize(t) { return (t || document.title || "Export").trim().replace(/[\/\\\?\%\*\:\|"<>\.]/g, "_"); }
    function getTitle() {
        if (P === "chatGPT")  return sanitize(qs("#history a[data-active]")?.textContent);
        if (P === "gemini")   return sanitize(qs("conversations-list div.selected")?.textContent || document.title.replace(/ - Google Gemini$/, '').trim().slice(0, 30));
        if (P === "deepseek") {
            const byZ = qsa('[style*="z-index"], div').find(el => getComputedStyle(el).zIndex === "12");
            return sanitize(byZ?.textContent || qs('div[class*="chat-item--active"] span,li[class*="active"] .title,a[class*="active"] span')?.textContent);
        }
        if (P === "yuanbao") return sanitize(qs("span.agent-dialogue__content--common__header__name__title")?.textContent);
        return sanitize(document.title);
    }

    // ─── HTML → Markdown ─────────────────────────────────────────────────────────
    function toMd(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const isGemini=P==="gemini",isGrok=P==="grok",isChatGPT=P==="chatGPT",isClaude=P==="claude",isDS=P==="deepseek";
        if (!isGemini) qsa("span.katex-html",doc).forEach(e=>e.remove());
        qsa("mrow",doc).forEach(e=>e.remove());
        qsa('annotation[encoding="application/x-tex"]',doc).forEach(e=>
            e.replaceWith(e.closest(".katex-display")?`\n$$\n${e.textContent.trim()}\n$$\n`:`$${e.textContent.trim()}$`));
        const rp=(el,txt)=>el.parentNode.replaceChild(document.createTextNode(txt),el);
        qsa("strong,b",doc).forEach(e=>rp(e,`**${e.textContent}**`));
        qsa("em,i",doc).forEach(e=>rp(e,`*${e.textContent}*`));
        qsa("p code",doc).forEach(e=>rp(e,`\`${e.textContent}\``));
        qsa("a",doc).forEach(e=>rp(e,`[${e.textContent}](${e.href})`));
        qsa("img",doc).forEach(e=>rp(e,`![${e.alt}](${e.src})`));
        if (isChatGPT) {
            qsa("pre",doc).forEach(pre=>{const type=qs("div>div:first-child",pre)?.textContent||"";const code=qs("div>div:nth-child(3)>code",pre)?.textContent||pre.textContent;pre.innerHTML=`\n\`\`\`${type}\n${code}\n\`\`\`\n`;});
        } else if (isGrok) {
            qsa("div.not-prose",doc).forEach(d=>{const type=qs("div>div>span",d)?.textContent||"";const code=qs("div>div:nth-child(3)>code",d)?.textContent||d.textContent;d.innerHTML=`\n\`\`\`${type}\n${code}\n\`\`\`\n`;});
        } else if (isGemini) {
            qsa("code-block",doc).forEach(d=>{const type=qs("div>div>span",d)?.textContent||"";const code=qs("div>div:nth-child(2)>div>pre",d)?.textContent||d.textContent;d.innerHTML=`\n\`\`\`${type}\n${code}\n\`\`\`\n`;});
        } else if (isClaude) {
            qsa("pre",doc).forEach(pre=>{const code=qs("code",pre);const type=code?Array.from(code.classList).find(c=>c.startsWith("language-"))?.replace("language-","")||"":"";pre.innerHTML=`\n\`\`\`${type}\n${code?code.textContent:pre.textContent}\n\`\`\`\n`;});
        } else if (isDS) {
            qsa("pre",doc).forEach(pre=>{const code=qs("code",pre);let type=code?Array.from(code.classList).find(c=>c.startsWith("language-"))?.replace("language-","")||"":"";if(!type)type=qs('span.code-lang,span[class*="lang"],div[class*="code-header"] span',pre.closest("div"))?.textContent.trim()||"";pre.innerHTML=`\n\`\`\`${type}\n${code?code.textContent:pre.textContent}\n\`\`\`\n`;});
            qsa('div[class*="think"],details.think,div.ds-think',doc).forEach(e=>rp(e,`\n> **[Thinking]**\n${e.textContent.trim().split("\n").map(l=>`> ${l}`).join("\n")}\n`));
        }
        qsa("ul",doc).forEach(ul=>rp(ul,"\n"+qsa(":scope>li",ul).map(li=>`- ${li.textContent.trim()}`).join("\n")));
        qsa("ol",doc).forEach(ol=>rp(ol,"\n"+qsa(":scope>li",ol).map((li,i)=>`${i+1}. ${li.textContent.trim()}`).join("\n")));
        for(let i=1;i<=6;i++) qsa(`h${i}`,doc).forEach(h=>rp(h,`\n${"#".repeat(i)} ${h.textContent}\n`));
        qsa("p",doc).forEach(p=>rp(p,`\n${p.textContent}\n`));
        return doc.body.innerHTML.replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").trim();
    }

    // ─── DeepSeek virtual-list scraper ───────────────────────────────────────────
    async function getDeepSeekContents() {
        const vl=qs('div.ds-virtual-list'); if(!vl) return [];
        const totalHeight=parseInt(qs('div.ds-virtual-list-items')?.style.minHeight)||vl.scrollHeight;
        const allItems=new Map();
        const collect=()=>{qsa('[data-virtual-list-item-key]').forEach(item=>{const key=item.getAttribute('data-virtual-list-item-key');if(allItems.has(key))return;const aiEl=item.querySelector('div.ds-assistant-message-main-content');if(aiEl)allItems.set(key,{role:'assistant',key:Number(key),html:aiEl.innerHTML});else{const msgEl=item.querySelector('div.ds-message');if(msgEl)allItems.set(key,{role:'user',key:Number(key),text:msgEl.textContent.trim()});}});};
        vl.scrollTo(0,0);await new Promise(r=>setTimeout(r,400));collect();
        for(let y=300;y<=totalHeight+600;y+=300){vl.scrollTo(0,y);await new Promise(r=>setTimeout(r,80));collect();}
        vl.scrollTo(0,totalHeight);await new Promise(r=>setTimeout(r,300));collect();
        return Array.from(allItems.values()).sort((a,b)=>a.key-b.key).map(item=>({role:item.role,text:item.role==='assistant'?toMd(item.html):item.text}));
    }

    // ─── Attachments ─────────────────────────────────────────────────────────────
    function extractAttachments(msgEl) {
        const seen=new Set(),out=[];
        qsa("img[src]",msgEl).forEach(img=>{const src=img.src||"";if(src&&!seen.has(src)&&!src.includes("avatar")&&!src.includes("icon")&&src!==window.location.href){seen.add(src);out.push({name:img.alt||"image",type:"image",src});}});
        qsa('[data-testid*="file-thumbnail"],[class*="FileAttachment"],[class*="file-name"],[class*="attachment-name"]',msgEl).forEach(el=>{const name=(el.querySelector('[class*="name"],span,p')||el).textContent.trim();if(name&&name.length<200&&!seen.has(name)){seen.add(name);out.push({name,type:"file",src:null});}});
        return out;
    }
    function renderAttachmentsMd(a){if(!a.length)return "";return "\n**Attachments:**\n"+a.map(x=>x.type==="image"?`![${x.name}](${x.src})`:`- \`${x.name}\``).join("\n")+"\n";}

    // ─── getElements ─────────────────────────────────────────────────────────────
    function getElements() {
        const res=[];
        if(P==="chatGPT")  res.push(...qsa("article"));
        else if(P==="grok") res.push(...qsa("div.message-bubble"));
        else if(P==="gemini"){const q=qsa("user-query-content"),r=qsa("model-response");q.forEach((x,i)=>{res.push(x);if(r[i])res.push(r[i]);});}
        else if(P==="claude") res.push(...qsa('[data-testid="user-message"],.font-claude-response'));
        else if(P==="yuanbao") res.push(...qsa("div.agent-chat__list__item"));
        return res;
    }

    // ─── File export ─────────────────────────────────────────────────────────────
    async function fileExport(fmt) {
        let c="",m="text/plain",title,fname;
        if(P==="deepseek"){
            const items=await getDeepSeekContents();if(!items.length)return;
            title=getTitle();const pl=[];
            for(let i=0;i<items.length-1;i++)if(items[i].role==='user'&&items[i+1]?.role==='assistant')pl.push({q:items[i].text,a:items[i+1].text});
            fname=makeFilename(title,pl.length);
            if(fmt==="json"){c=JSON.stringify(pl,null,2);m="application/json";}
            else if(fmt==="csv"){c="Q,A\n"+pl.map(p=>`"${p.q.replace(/"/g,'""')}","${p.a.replace(/"/g,'""')}"`).join("\n");m="text/csv";}
            else if(fmt==="html"){c=`<html><body style="font-family:sans-serif;max-width:800px;margin:auto;padding:30px;line-height:1.7;">${pl.map(p=>`<div style="background:#f4f4f5;padding:15px;border-radius:12px;margin:20px 0;"><b>Q:</b> ${p.q}</div><div><b>A:</b> ${p.a}</div><hr/>`).join("")}</body></html>`;m="text/html";}
            else if(fmt==="md"){c=pl.map(p=>`\n# Q:\n${p.q}\n\n# A:\n${p.a}\n\n---\n`).join("");m="text/markdown";}
            else{c=pl.map(p=>`\nQ:\n${p.q}\n\nA:\n${p.a}\n\n---\n`).join("");}
        } else {
            const res=getElements();if(!res.length)return;
            title=getTitle();fname=makeFilename(title,Math.floor(res.length/2));
            const md=el=>toMd(el.innerHTML),txt=el=>el.textContent.trim();
            if(fmt==="json"){c=JSON.stringify(res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a.push({q:md(x),a:md(res[i+1])});return a;},[]),null,2);m="application/json";}
            else if(fmt==="csv"){c="Q,A\n"+res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`"${md(x).replace(/"/g,'""')}","${md(res[i+1]).replace(/"/g,'""')}"\n`;return a;},"");m="text/csv";}
            else if(fmt==="html"){c=`<html><body style="font-family:sans-serif;max-width:800px;margin:auto;padding:30px;line-height:1.7;">${res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`<div style="background:#f4f4f5;padding:15px;border-radius:12px;margin:20px 0;"><b>Q:</b> ${x.innerHTML}</div><div><b>A:</b> ${res[i+1].innerHTML}</div><hr/>`;return a;},"")}</body></html>`;m="text/html";}
            else if(fmt==="md"){c=res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`\n# Q:\n${md(x)}\n\n# A:\n${md(res[i+1])}\n\n---\n`;return a;},"");m="text/markdown";}
            else{c=res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`\nQ:\n${txt(x)}\n\nA:\n${txt(res[i+1])}\n\n---\n`;return a;},"");}
        }
        const u=URL.createObjectURL(new Blob([c.replace(/&amp;/g,"&")],{type:m}));
        const a=Object.assign(document.createElement("a"),{href:u,download:`${fname}.${fmt}`});
        document.body.appendChild(a);a.click();
        setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(u);},0);
    }

    // ─── Obsidian export ──────────────────────────────────────────────────────────
    async function obsidianExport() {
        let body="",title,pairs;
        if(P==="deepseek"){
            const items=await getDeepSeekContents();if(!items.length){alert("No conversation found!");return;}
            title=getTitle();pairs=items.filter(x=>x.role==='user').length;
            for(let i=0;i<items.length-1;i++)if(items[i].role==='user'&&items[i+1]?.role==='assistant')body+=`# Q:\n${items[i].text}\n\n# A:\n${items[i+1].text}\n\n---\n\n`;
        } else {
            const res=getElements();if(!res.length){alert("No conversation found!");return;}
            title=getTitle();pairs=Math.floor(res.length/2);
            res.forEach((el,i)=>{if(i%2===0&&res[i+1]){const att=extractAttachments(el);body+=`# Q:\n${toMd(el.innerHTML)}\n`;if(att.length)body+=renderAttachmentsMd(att);body+=`\n# A:\n${toMd(res[i+1].innerHTML)}\n\n---\n\n`;}});
        }
        const fname=makeFilename(title,pairs);
        const yaml=["---",`title: "${title}"`,`date: "${new Date().toISOString()}"`,`source: ${P}`,`url: "${document.URL}"`,`turns: ${pairs}`,"tags:","  - chat",`  - ${P}`,"---",""].join("\n")+"\n";
        GM_setClipboard(yaml+body.replace(/&amp;/g,"&"));
        const folder=encodeURIComponent(CFG.obsFolder+"/"+P);
        const obsUrl=`obsidian://new?file=${folder}%2F${encodeURIComponent(fname)}&clipboard`;
        GM_xmlhttpRequest({
            method:'POST', url:'http://127.0.0.1:27184/obsidian',
            headers:{'Content-Type':'application/json'},
            data:JSON.stringify({uri:obsUrl}),
            timeout:1500,
            onload(r){try{if(JSON.parse(r.responseText).ok)return;}catch(_){}_obsidianTabFallback(obsUrl);},
            onerror(){_obsidianTabFallback(obsUrl);},
            ontimeout(){_obsidianTabFallback(obsUrl);},
        });
    }

    function _obsidianTabFallback(obsUrl) {
        const tab=GM_openInTab(obsUrl,{active:false,insert:true});
        if(CFG.obsTabCloseMs>0&&tab&&typeof tab.close==="function") setTimeout(()=>tab.close(),CFG.obsTabCloseMs);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ENTER-AS-NEWLINE
    // ═══════════════════════════════════════════════════════════════════════════
    function getEventTarget(e)   {return e.composedPath?e.composedPath()[0]||e.target:e.target;}
    function isComposing(e)      {return e.isComposing||e.keyCode===229;}
    function isEditableTarget(t) {return /INPUT|TEXTAREA|SELECT/.test(t.tagName)||(t.getAttribute&&t.getAttribute("contenteditable")==="true");}
    function isChatGPTTarget(t)  {return t.id==="prompt-textarea"||t.closest("#prompt-textarea")||(t.getAttribute&&t.getAttribute("contenteditable")==="true");}
    function isSendShortcut(e) {
        if(e.key!=="Enter") return false;
        const sc=CFG.shortcuts;
        return (sc.ctrl&&e.ctrlKey&&!e.altKey&&!e.metaKey)||(sc.alt&&e.altKey&&!e.ctrlKey&&!e.metaKey)||(sc.meta&&e.metaKey&&!e.ctrlKey&&!e.altKey);
    }
    function isPotentialSend(e) {
        if(e.key!=="Enter") return false;
        return (e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey)||(e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey)||(e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey);
    }
    function findSubmit() {
        if(P==="chatGPT") return qs('button[data-testid="send-button"]');
        if(P==="gemini")  return qs('button[aria-label*="Send"],button[aria-label*="发送"],button[aria-label*="傳送"]');
        if(P==="deepseek"){const bc=qs(".bf38813a");if(!bc)return null;const btns=qsa('.ds-icon-button[role="button"]',bc);for(let i=btns.length-1;i>=0;i--){const b=btns[i];if(b.getAttribute("aria-disabled")!=="true"&&!b.classList.contains("ds-icon-button--disabled"))return b;}return null;}
        if(P==="claude")  return qs('button[aria-label*="Send"]');
        if(P==="grok")    return qs('button[type="submit"]');
        return null;
    }

    window.addEventListener("keydown", e => {
        if(isComposing(e)) return;
        const t=getEventTarget(e);
        if(P==="chatGPT"){
            if(e.key==="Enter"&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey&&!e.altKey&&isChatGPTTarget(t)){
                e.stopPropagation();e.preventDefault();
                const ev=new KeyboardEvent("keydown",{key:"Enter",code:"Enter",shiftKey:true,bubbles:true,cancelable:true});
                t.dispatchEvent(ev);
                if(!ev.defaultPrevented) document.execCommand("insertParagraph");
                return;
            }
            if(isSendShortcut(e)&&isChatGPTTarget(t)){applyCavemanIfActive();const sb=findSubmit();if(sb&&!sb.disabled){e.preventDefault();e.stopPropagation();sb.click();}return;}
            if(isPotentialSend(e)&&isChatGPTTarget(t)){e.preventDefault();e.stopPropagation();}
            return;
        }
        if(e.key==="Enter"&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey&&!e.altKey&&isEditableTarget(t)){
            e.preventDefault();e.stopPropagation();
            if(t.tagName==="TEXTAREA"){const s=t.selectionStart,v=t.value;t.value=v.substring(0,s)+"\n"+v.substring(t.selectionEnd);t.selectionStart=t.selectionEnd=s+1;t.dispatchEvent(new Event("input",{bubbles:true}));}
            else{const ev=new KeyboardEvent("keydown",{key:"Enter",code:"Enter",shiftKey:true,bubbles:true,cancelable:true});t.dispatchEvent(ev);if(!ev.defaultPrevented)document.execCommand("insertParagraph");}
            return;
        }
        if(isSendShortcut(e)&&isEditableTarget(t)){applyCavemanIfActive();const sb=findSubmit();if(sb&&!sb.disabled){e.preventDefault();e.stopPropagation();sb.click();}return;}
        if(isPotentialSend(e)&&isEditableTarget(t)){e.stopPropagation();}
    },true);

    window.addEventListener("keypress",e=>{
        if(P==="chatGPT"||isComposing(e))return;
        if(e.key==="Enter"&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey&&!e.altKey){const t=getEventTarget(e);if(isEditableTarget(t))e.stopPropagation();}
        if(isPotentialSend(e)){const t=getEventTarget(e);if(isEditableTarget(t))e.stopPropagation();}
    },true);

    // ═══════════════════════════════════════════════════════════════════════════
    //  SETTINGS DASHBOARD  — monotone dark theme
    // ═══════════════════════════════════════════════════════════════════════════
    function openDashboard() {
        const existing=qs('#lance-dashboard');
        if(existing){existing.remove();qs('#lance-overlay')?.remove();return;}

        // Monotone dark palette — no accent colours, only grey/white shades
        const bg   = "#18181b";
        const bg2  = "#1f1f23";
        const bg3  = "#27272c";
        const fg   = "#e4e4e8";
        const fg2  = "rgba(228,228,232,0.5)";
        const bd   = "rgba(255,255,255,0.07)";
        const wht  = "#ffffff";

        const ov=document.createElement('div');
        ov.id='lance-overlay';
        Object.assign(ov.style,{position:'fixed',inset:'0',background:'rgba(0,0,0,0.6)',zIndex:'2147483645',backdropFilter:'blur(2px)'});
        ov.onclick=()=>{ov.remove();dlg.remove();};
        document.body.appendChild(ov);

        const dlg=document.createElement('div');
        dlg.id='lance-dashboard';
        Object.assign(dlg.style,{
            position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
            background:bg,color:fg,border:`1px solid ${bd}`,borderRadius:'14px',
            padding:'20px 24px 24px',width:'360px',maxWidth:'94vw',maxHeight:'88vh',
            overflowY:'auto',zIndex:'2147483646',
            fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            fontSize:'13px',lineHeight:'1.5',
            boxShadow:'0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)',
        });

        // Scrollbar styling
        dlg.style.scrollbarWidth='thin';
        dlg.style.scrollbarColor=`${bg3} transparent`;

        const row=(label,control)=>{
            const d=document.createElement('div');
            Object.assign(d.style,{display:'flex',justifyContent:'space-between',alignItems:'center',
                padding:'9px 0',borderBottom:`1px solid ${bd}`});
            const la=document.createElement('span');la.textContent=label;la.style.color=fg;
            d.appendChild(la);if(control)d.appendChild(control);
            return d;
        };

        // Toggle — monotone: active=white track, inactive=dark track
        const toggle=(val,onChange)=>{
            const lbl=document.createElement('label');
            Object.assign(lbl.style,{position:'relative',display:'inline-block',width:'34px',height:'18px',flexShrink:'0'});
            const inp=document.createElement('input');inp.type='checkbox';inp.checked=val;
            Object.assign(inp.style,{opacity:'0',width:'0',height:'0',position:'absolute'});
            const sl=document.createElement('span');
            Object.assign(sl.style,{position:'absolute',inset:'0',borderRadius:'18px',cursor:'pointer',
                background:val?wht:'rgba(255,255,255,0.12)',transition:'background 0.18s',
                border:'1px solid rgba(255,255,255,0.1)'});
            const dot=document.createElement('span');
            Object.assign(dot.style,{position:'absolute',height:'12px',width:'12px',
                left:val?'18px':'3px',bottom:'2px',
                background:val?'#111':'rgba(255,255,255,0.4)',
                borderRadius:'50%',transition:'left 0.18s, background 0.18s'});
            sl.appendChild(dot);
            inp.onchange=()=>{
                const v=inp.checked;
                sl.style.background=v?wht:'rgba(255,255,255,0.12)';
                dot.style.left=v?'18px':'3px';
                dot.style.background=v?'#111':'rgba(255,255,255,0.4)';
                onChange(v);
            };
            lbl.appendChild(inp);lbl.appendChild(sl);
            return lbl;
        };

        const section=t=>{
            const d=document.createElement('div');
            Object.assign(d.style,{fontSize:'10px',fontWeight:'700',letterSpacing:'0.1em',
                textTransform:'uppercase',color:fg2,padding:'18px 0 6px'});
            d.textContent=t;return d;
        };

        const textInput=(val,onInput,opts={})=>{
            const inp=document.createElement('input');
            inp.value=val;
            if(opts.type)  inp.type=opts.type;
            if(opts.min)   inp.min=opts.min;
            if(opts.max)   inp.max=opts.max;
            if(opts.step)  inp.step=opts.step;
            Object.assign(inp.style,{
                background:bg3,border:`1px solid rgba(255,255,255,0.1)`,borderRadius:'6px',
                color:fg,padding:'5px 9px',fontSize:'12px',
                width:opts.width||'100%',boxSizing:'border-box',
                textAlign:opts.align||'left',
                outline:'none',
            });
            inp.addEventListener('focus',()=>{inp.style.borderColor='rgba(255,255,255,0.25)';});
            inp.addEventListener('blur', ()=>{inp.style.borderColor='rgba(255,255,255,0.1)';});
            inp.oninput=()=>onInput(inp.value);
            return inp;
        };

        // ── Header ──
        const hdr=document.createElement('div');
        Object.assign(hdr.style,{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'2px'});
        const htitle=document.createElement('div');
        Object.assign(htitle.style,{display:'flex',alignItems:'baseline',gap:'8px'});
        const hname=document.createElement('span');hname.textContent='lance';
        Object.assign(hname.style,{fontSize:'17px',fontWeight:'700',color:wht});
        const hver=document.createElement('span');hver.textContent='v0.0.4';
        Object.assign(hver.style,{fontSize:'10px',color:fg2});
        htitle.appendChild(hname);htitle.appendChild(hver);
        const closeBtn=document.createElement('button');closeBtn.textContent='✕';
        Object.assign(closeBtn.style,{background:'none',border:'none',color:fg2,cursor:'pointer',
            fontSize:'16px',padding:'0',lineHeight:'1',transition:'color 0.1s'});
        closeBtn.addEventListener('mouseenter',()=>{closeBtn.style.color=wht;});
        closeBtn.addEventListener('mouseleave',()=>{closeBtn.style.color=fg2;});
        closeBtn.onclick=()=>{dlg.remove();ov.remove();};
        hdr.appendChild(htitle);hdr.appendChild(closeBtn);
        dlg.appendChild(hdr);

        // Subtitle
        const sub=document.createElement('div');
        sub.textContent='All changes save instantly.';
        Object.assign(sub.style,{fontSize:'11px',color:fg2,marginBottom:'4px'});
        dlg.appendChild(sub);

        // ── Sites ──
        dlg.appendChild(section('Export button — sites'));
        const SITE_LABELS={chatGPT:'ChatGPT',grok:'Grok',gemini:'Gemini',claude:'Claude',deepseek:'DeepSeek',yuanbao:'Yuanbao'};
        Object.entries(SITE_LABELS).forEach(([key,label])=>{
            dlg.appendChild(row(label, toggle(CFG.sites[key]??true, v=>{CFG.sites[key]=v;saveCfg(CFG);})));
        });

        // ── Keyboard ──
        dlg.appendChild(section('Send shortcut (+ Enter)'));
        [['ctrl','Ctrl + Enter'],['meta','Cmd / Win + Enter'],['alt','Alt / Option + Enter']].forEach(([key,label])=>{
            dlg.appendChild(row(label, toggle(CFG.shortcuts[key]??DEFAULTS.shortcuts[key], v=>{CFG.shortcuts[key]=v;saveCfg(CFG);})));
        });

        // ── Obsidian ──
        dlg.appendChild(section('Obsidian'));

        // Relay status
        const relayRow=document.createElement('div');
        Object.assign(relayRow.style,{padding:'9px 0',borderBottom:`1px solid ${bd}`,display:'flex',justifyContent:'space-between',alignItems:'center'});
        const relayLbl=document.createElement('span');relayLbl.textContent='lance-relay';relayLbl.style.color=fg;
        const relayStatus=document.createElement('span');relayStatus.textContent='checking…';
        Object.assign(relayStatus.style,{fontSize:'11px',color:fg2});
        relayRow.appendChild(relayLbl);relayRow.appendChild(relayStatus);
        dlg.appendChild(relayRow);
        // FIX: ping correct endpoint /ping not /obsidian
        GM_xmlhttpRequest({
            method:'GET',url:'http://127.0.0.1:27184/ping',timeout:1200,
            onload(r){
                try{const d=JSON.parse(r.responseText);if(d.ok){relayStatus.textContent='● online';relayStatus.style.color='rgba(255,255,255,0.75)';return;}}catch(_){}
                relayStatus.textContent='● offline';relayStatus.style.color='rgba(255,255,255,0.25)';
            },
            onerror() {relayStatus.textContent='● offline';relayStatus.style.color='rgba(255,255,255,0.25)';},
            ontimeout(){relayStatus.textContent='● offline';relayStatus.style.color='rgba(255,255,255,0.25)';},
        });

        // Vault folder
        const folderWrap=document.createElement('div');
        Object.assign(folderWrap.style,{padding:'9px 0',borderBottom:`1px solid ${bd}`});
        const folderLbl=document.createElement('div');folderLbl.textContent='Vault folder';
        Object.assign(folderLbl.style,{marginBottom:'6px',color:fg,fontSize:'12px'});
        folderWrap.appendChild(folderLbl);
        folderWrap.appendChild(textInput(CFG.obsFolder,v=>{CFG.obsFolder=v.trim()||"Chat";saveCfg(CFG);}));
        dlg.appendChild(folderWrap);

        // Tab close delay
        dlg.appendChild(row('Fallback tab close (ms, 0=off)',
            textInput(String(CFG.obsTabCloseMs),v=>{CFG.obsTabCloseMs=Math.max(0,parseInt(v)||0);saveCfg(CFG);},{type:'number',min:'0',max:'10000',step:'100',width:'72px',align:'right'})
        ));

        // ── Caveman ──
        dlg.appendChild(section('Caveman mode'));
        dlg.appendChild(row('Enable',toggle(CFG.caveman?.enabled??false,v=>{
            if(!CFG.caveman)CFG.caveman={enabled:false,level:'ultra'};
            CFG.caveman.enabled=v;saveCfg(CFG);updateCavemanPill();
        })));

        // Level selector — monotone select style
        const lvlRow=document.createElement('div');
        Object.assign(lvlRow.style,{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0',borderBottom:`1px solid ${bd}`});
        const lvlLbl=document.createElement('span');lvlLbl.textContent='Level';lvlLbl.style.color=fg;
        const lvlSel=document.createElement('select');
        Object.assign(lvlSel.style,{background:bg3,border:'1px solid rgba(255,255,255,0.1)',
            borderRadius:'6px',color:fg,padding:'4px 8px',fontSize:'12px',outline:'none'});
        ['lite','full','ultra'].forEach(l=>{
            const opt=document.createElement('option');opt.value=l;
            opt.textContent=l.charAt(0).toUpperCase()+l.slice(1);
            if((CFG.caveman?.level||'ultra')===l)opt.selected=true;
            lvlSel.appendChild(opt);
        });
        lvlSel.onchange=()=>{if(!CFG.caveman)CFG.caveman={enabled:false,level:'ultra'};CFG.caveman.level=lvlSel.value;saveCfg(CFG);updateCavemanPill();};
        lvlRow.appendChild(lvlLbl);lvlRow.appendChild(lvlSel);
        dlg.appendChild(lvlRow);

        const note=document.createElement('p');
        note.textContent='Cave button: click to open menu → toggle or select level.';
        Object.assign(note.style,{margin:'12px 0 0',fontSize:'10px',color:fg2,textAlign:'center'});
        dlg.appendChild(note);

        document.body.appendChild(dlg);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  STYLES  — monotone dark, no accent colours
    // ═══════════════════════════════════════════════════════════════════════════
    GM_addStyle(`
        .ai-export-drag-box {
            position:fixed;z-index:2147483646;
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            background:rgba(24,24,27,0.9);backdrop-filter:blur(14px);
            color:rgba(255,255,255,0.85);border-radius:100px;
            box-shadow:0 4px 24px rgba(0,0,0,0.4),0 0 0 1px rgba(255,255,255,0.07);
            cursor:move;user-select:none;
            padding:9px 18px;font-family:system-ui;font-size:13px;font-weight:600;
            transition:transform 0.15s,box-shadow 0.15s;white-space:nowrap;
        }
        .ai-export-drag-box:hover {
            transform:scale(1.04);
            color:#fff;
            box-shadow:0 6px 30px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.12);
        }
        .ai-export-menu-panel {
            position:absolute;width:max-content;min-width:185px;
            background:#18181b;border:1px solid rgba(255,255,255,0.07);
            border-radius:12px;padding:4px;display:none;flex-direction:column;gap:1px;
            box-shadow:0 12px 40px rgba(0,0,0,0.6);
        }
        .pos-bottom-right{bottom:calc(100% + 12px);right:0;transform-origin:bottom right;animation:aiPopUp .2s cubic-bezier(.16,1,.3,1);}
        .pos-bottom-left {bottom:calc(100% + 12px);left:0; transform-origin:bottom left; animation:aiPopUp .2s cubic-bezier(.16,1,.3,1);}
        .pos-top-right   {top:calc(100% + 12px);   right:0;transform-origin:top right;   animation:aiPopDown .2s cubic-bezier(.16,1,.3,1);}
        .pos-top-left    {top:calc(100% + 12px);   left:0; transform-origin:top left;    animation:aiPopDown .2s cubic-bezier(.16,1,.3,1);}
        @keyframes aiPopUp   {0%{opacity:0;transform:scale(.94) translateY(6px) }100%{opacity:1;transform:scale(1) translateY(0)}}
        @keyframes aiPopDown {0%{opacity:0;transform:scale(.94) translateY(-6px)}100%{opacity:1;transform:scale(1) translateY(0)}}
        .ai-export-menu-item {
            display:flex;align-items:center;padding:9px 12px;
            background:transparent;border:none;border-radius:8px;text-align:left;
            cursor:pointer;color:rgba(228,228,232,0.75);font-size:12px;font-weight:500;
            transition:background .1s,color .1s,transform .08s;width:100%;white-space:nowrap;
            letter-spacing:0.01em;
        }
        .ai-export-menu-item:hover  {background:rgba(255,255,255,0.07);color:#fff;}
        .ai-export-menu-item:active,
        .ai-export-menu-item.clicked{transform:scale(.95);opacity:.6;}
        .ai-export-menu-divider     {height:1px;background:rgba(255,255,255,0.06);margin:2px 6px;}
        .ai-export-section-label    {font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,0.25);padding:7px 12px 2px;}
        .ai-export-badge            {margin-left:auto;font-size:9px;font-weight:700;letter-spacing:.04em;font-family:monospace;color:rgba(255,255,255,0.2);}
    `);

    // ─── UI ──────────────────────────────────────────────────────────────────────
    function init() {
        if(CFG.sites[P]===false){qs('.ai-export-drag-box')?.remove();return;}
        if(qs('.ai-export-drag-box')) return;

        const box=mkEl("div",{className:"ai-export-drag-box"});
        box.innerHTML=`<div style="display:flex;align-items:center;gap:7px;pointer-events:none;">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            <span>Export</span>
        </div>`;
        const menu=mkEl("div",{className:"ai-export-menu-panel"});
        const addLabel=t=>menu.appendChild(Object.assign(document.createElement('div'),{className:'ai-export-section-label',textContent:t}));
        const addDiv=()=>menu.appendChild(mkEl("div",{className:"ai-export-menu-divider"}));
        const addBtn=(icon,label,badge,cls,fn)=>{
            const btn=mkEl("button",{className:`ai-export-menu-item${cls?' '+cls:''}`});
            btn.innerHTML=`<span style="font-family:monospace;font-size:10px;width:16px;text-align:center;opacity:.45;flex-shrink:0">${icon}</span><span style="margin-left:4px">${label}</span><span class="ai-export-badge">${badge}</span>`;
            btn.onclick=e=>{e.stopPropagation();btn.classList.add('clicked');setTimeout(()=>{btn.classList.remove('clicked');menu.style.display='none';fn();},160);};
            menu.appendChild(btn);
        };

        addLabel("Download");
        addBtn('#', 'Markdown',   '.MD',   '', ()=>fileExport('md'));
        addBtn('{}','JSON',       '.JSON', '', ()=>fileExport('json'));
        addBtn(',', 'CSV',        '.CSV',  '', ()=>fileExport('csv'));
        addBtn('T', 'Plain text', '.TXT',  '', ()=>fileExport('txt'));
        addBtn('<>','HTML',       '.HTML', '', ()=>fileExport('html'));
        addDiv();
        addLabel("Integrations");
        addBtn('◆', 'Obsidian',  '.MD',   '', ()=>obsidianExport());
        addDiv();
        addBtn('⚙', 'Settings',  '',      '', ()=>openDashboard());

        box.appendChild(menu);
        document.body.appendChild(box);

        const sX=GM_getValue('x',window.innerWidth-160),sY=GM_getValue('y',window.innerHeight-100);
        box.style.left=Math.max(0,Math.min(sX,window.innerWidth-120))+'px';
        box.style.top =Math.max(0,Math.min(sY,window.innerHeight-60))+'px';

        let drag=false,moved=false,sX0,sY0,iL,iT;
        box.onmousedown=e=>{drag=true;moved=false;sX0=e.clientX;sY0=e.clientY;iL=box.offsetLeft;iT=box.offsetTop;e.preventDefault();};
        document.onmousemove=e=>{if(!drag)return;const dx=e.clientX-sX0,dy=e.clientY-sY0;if(Math.abs(dx)>3||Math.abs(dy)>3)moved=true;box.style.left=(iL+dx)+'px';box.style.top=(iT+dy)+'px';};
        document.onmouseup=()=>{if(drag&&moved){GM_setValue('x',box.offsetLeft);GM_setValue('y',box.offsetTop);}drag=false;};
        box.onclick=()=>{
            if(moved)return;
            if(menu.style.display!=='flex'){
                const rect=box.getBoundingClientRect(),isB=rect.top>window.innerHeight/2,isR=rect.left>window.innerWidth/2;
                menu.className='ai-export-menu-panel';
                menu.classList.add(isB?isR?'pos-bottom-right':'pos-bottom-left':isR?'pos-top-right':'pos-top-left');
                menu.style.display='flex';
            } else menu.style.display='none';
        };
        document.addEventListener("click",e=>{if(!box.contains(e.target))menu.style.display='none';});
    }

    GM_registerMenuCommand("⚙ lance settings",openDashboard);

    if(typeof trustedTypes!=="undefined"&&trustedTypes.defaultPolicy===null)
        trustedTypes.createPolicy("default",{createHTML:s=>s,createScriptURL:s=>s,createScript:s=>s});

    // FIX: pill updateCavemanPill called in interval so status stays fresh across re-inits
    setTimeout(()=>{init();initCavemanPill();},1000);
    setInterval(()=>{init();initCavemanPill();updateCavemanPill();},3000);
})();
