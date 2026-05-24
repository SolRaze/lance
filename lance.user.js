// ==UserScript==
// @name         lance
// @namespace    https://github.com/user/lance
// @version      0.0.21
// @description  AI chat toolkit — export, Obsidian sync (silent relay), Enter-as-newline, settings dashboard
// @author       user
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
        // Per-site export button visibility
        sites: {
            chatGPT:  true,
            grok:     true,
            gemini:   true,
            claude:   true,
            deepseek: true,
            yuanbao:  true,
        },
        // Enter-as-newline send shortcut
        shortcuts: { ctrl: true, meta: true, alt: false },
        // Obsidian vault subfolder (after Chat/<platform>/)
        obsFolder: "Chat",
        // Auto-close the obsidian:// tab after N ms (0 = disabled)
        obsTabCloseMs: 1500,
    };

    function loadCfg() {
        try {
            const s = GM_getValue("lance_cfg");
            if (s) return Object.assign({}, DEFAULTS, JSON.parse(s));
        } catch(_) {}
        return Object.assign({}, DEFAULTS);
    }
    function saveCfg(c) { GM_setValue("lance_cfg", JSON.stringify(c)); }

    let CFG = loadCfg();

    // ─── Filename: YYYYMMDDXXXX ──────────────────────────────────────────────────
    function makeFilename(title, turnCount) {
        const d    = new Date();
        const date = d.getFullYear().toString()
                   + String(d.getMonth() + 1).padStart(2, "0")
                   + String(d.getDate()).padStart(2, "0");
        return `${date}${String(turnCount).padStart(4,"0")}_${title}`;
    }

    // ─── Title ───────────────────────────────────────────────────────────────────
    function sanitize(t) {
        return (t || document.title || "Export").trim().replace(/[\/\\\?\%\*\:\|"<>\.]/g, "_");
    }
    function getTitle() {
        if (P === "chatGPT")  return sanitize(qs("#history a[data-active]")?.textContent);
        if (P === "gemini")   return sanitize(
            qs("conversations-list div.selected")?.textContent ||
            document.title.replace(/ - Google Gemini$/, '').trim().slice(0, 30)
        );
        if (P === "deepseek") {
            const byZ = qsa('[style*="z-index"], div').find(el => getComputedStyle(el).zIndex === "12");
            return sanitize(byZ?.textContent || qs('div[class*="chat-item--active"] span, li[class*="active"] .title, a[class*="active"] span')?.textContent);
        }
        if (P === "yuanbao") return sanitize(qs("span.agent-dialogue__content--common__header__name__title")?.textContent);
        return sanitize(document.title);
    }

    // ─── HTML → Markdown ─────────────────────────────────────────────────────────
    function toMd(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const isGemini=P==="gemini", isGrok=P==="grok", isChatGPT=P==="chatGPT", isClaude=P==="claude", isDS=P==="deepseek";
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
            qsa("pre",doc).forEach(pre=>{
                const type=qs("div>div:first-child",pre)?.textContent||"";
                const code=qs("div>div:nth-child(3)>code",pre)?.textContent||pre.textContent;
                pre.innerHTML=`\n\`\`\`${type}\n${code}\n\`\`\`\n`;
            });
        } else if (isGrok) {
            qsa("div.not-prose",doc).forEach(d=>{
                const type=qs("div>div>span",d)?.textContent||"";
                const code=qs("div>div:nth-child(3)>code",d)?.textContent||d.textContent;
                d.innerHTML=`\n\`\`\`${type}\n${code}\n\`\`\`\n`;
            });
        } else if (isGemini) {
            qsa("code-block",doc).forEach(d=>{
                const type=qs("div>div>span",d)?.textContent||"";
                const code=qs("div>div:nth-child(2)>div>pre",d)?.textContent||d.textContent;
                d.innerHTML=`\n\`\`\`${type}\n${code}\n\`\`\`\n`;
            });
        } else if (isClaude) {
            qsa("pre",doc).forEach(pre=>{
                const code=qs("code",pre);
                const type=code?Array.from(code.classList).find(c=>c.startsWith("language-"))?.replace("language-","")||"":"";
                pre.innerHTML=`\n\`\`\`${type}\n${code?code.textContent:pre.textContent}\n\`\`\`\n`;
            });
        } else if (isDS) {
            qsa("pre",doc).forEach(pre=>{
                const code=qs("code",pre);
                let type=code?Array.from(code.classList).find(c=>c.startsWith("language-"))?.replace("language-","")||"":"";
                if(!type) type=qs('span.code-lang,span[class*="lang"],div[class*="code-header"] span',pre.closest("div"))?.textContent.trim()||"";
                pre.innerHTML=`\n\`\`\`${type}\n${code?code.textContent:pre.textContent}\n\`\`\`\n`;
            });
            qsa('div[class*="think"],details.think,div.ds-think',doc).forEach(e=>
                rp(e,`\n> **[Thinking]**\n${e.textContent.trim().split("\n").map(l=>`> ${l}`).join("\n")}\n`));
        }
        qsa("ul",doc).forEach(ul=>rp(ul,"\n"+qsa(":scope>li",ul).map(li=>`- ${li.textContent.trim()}`).join("\n")));
        qsa("ol",doc).forEach(ol=>rp(ol,"\n"+qsa(":scope>li",ol).map((li,i)=>`${i+1}. ${li.textContent.trim()}`).join("\n")));
        for(let i=1;i<=6;i++) qsa(`h${i}`,doc).forEach(h=>rp(h,`\n${"#".repeat(i)} ${h.textContent}\n`));
        qsa("p",doc).forEach(p=>rp(p,`\n${p.textContent}\n`));
        return doc.body.innerHTML.replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").trim();
    }

    // ─── DeepSeek virtual-list scraper ───────────────────────────────────────────
    async function getDeepSeekContents() {
        const vl=qs('div.ds-virtual-list');
        if(!vl) return [];
        const totalHeight=parseInt(qs('div.ds-virtual-list-items')?.style.minHeight)||vl.scrollHeight;
        const allItems=new Map();
        const collect=()=>{
            qsa('[data-virtual-list-item-key]').forEach(item=>{
                const key=item.getAttribute('data-virtual-list-item-key');
                if(allItems.has(key)) return;
                const aiEl=item.querySelector('div.ds-assistant-message-main-content');
                if(aiEl) allItems.set(key,{role:'assistant',key:Number(key),html:aiEl.innerHTML});
                else { const msgEl=item.querySelector('div.ds-message'); if(msgEl) allItems.set(key,{role:'user',key:Number(key),text:msgEl.textContent.trim()}); }
            });
        };
        vl.scrollTo(0,0); await new Promise(r=>setTimeout(r,400)); collect();
        for(let y=300;y<=totalHeight+600;y+=300){ vl.scrollTo(0,y); await new Promise(r=>setTimeout(r,80)); collect(); }
        vl.scrollTo(0,totalHeight); await new Promise(r=>setTimeout(r,300)); collect();
        return Array.from(allItems.values()).sort((a,b)=>a.key-b.key)
            .map(item=>({role:item.role, text:item.role==='assistant'?toMd(item.html):item.text}));
    }

    // ─── Attachments ─────────────────────────────────────────────────────────────
    function extractAttachments(msgEl) {
        const seen=new Set(),out=[];
        qsa("img[src]",msgEl).forEach(img=>{
            const src=img.src||"";
            if(src&&!seen.has(src)&&!src.includes("avatar")&&!src.includes("icon")&&src!==window.location.href)
                { seen.add(src); out.push({name:img.alt||"image",type:"image",src}); }
        });
        qsa('[data-testid*="file-thumbnail"],[class*="FileAttachment"],[class*="file-name"],[class*="attachment-name"]',msgEl).forEach(el=>{
            const name=(el.querySelector('[class*="name"],span,p')||el).textContent.trim();
            if(name&&name.length<200&&!seen.has(name)){seen.add(name);out.push({name,type:"file",src:null});}
        });
        return out;
    }
    function renderAttachmentsMd(a) {
        if(!a.length) return "";
        return "\n**Attachments:**\n"+a.map(x=>x.type==="image"?`![${x.name}](${x.src})`:`- \`${x.name}\``).join("\n")+"\n";
    }

    // ─── getElements ─────────────────────────────────────────────────────────────
    function getElements() {
        const res=[];
        if(P==="chatGPT")  res.push(...qsa("article"));
        else if(P==="grok") res.push(...qsa("div.message-bubble"));
        else if(P==="gemini") { const q=qsa("user-query-content"),r=qsa("model-response"); q.forEach((x,i)=>{res.push(x);if(r[i])res.push(r[i]);}); }
        else if(P==="claude") res.push(...qsa('[data-testid="user-message"],.font-claude-response'));
        else if(P==="yuanbao") res.push(...qsa("div.agent-chat__list__item"));
        return res;
    }

    // ─── File export ─────────────────────────────────────────────────────────────
    async function fileExport(fmt) {
        let c="",m="text/plain",title,fname;
        if(P==="deepseek") {
            const items=await getDeepSeekContents(); if(!items.length) return;
            title=getTitle();
            const pl=[];
            for(let i=0;i<items.length-1;i++) if(items[i].role==='user'&&items[i+1]?.role==='assistant') pl.push({q:items[i].text,a:items[i+1].text});
            fname=makeFilename(title,pl.length);
            if(fmt==="json")     { c=JSON.stringify(pl,null,2); m="application/json"; }
            else if(fmt==="csv") { c="Q,A\n"+pl.map(p=>`"${p.q.replace(/"/g,'""')}","${p.a.replace(/"/g,'""')}"`).join("\n"); m="text/csv"; }
            else if(fmt==="html"){ c=`<html><body style="font-family:sans-serif;max-width:800px;margin:auto;padding:30px;line-height:1.7;">${pl.map(p=>`<div style="background:#f4f4f5;padding:15px;border-radius:12px;margin:20px 0;"><b>Q:</b> ${p.q}</div><div><b>A:</b> ${p.a}</div><hr/>`).join("")}</body></html>`; m="text/html"; }
            else if(fmt==="md")  { c=pl.map(p=>`\n# Q:\n${p.q}\n\n# A:\n${p.a}\n\n---\n`).join(""); m="text/markdown"; }
            else                 { c=pl.map(p=>`\nQ:\n${p.q}\n\nA:\n${p.a}\n\n---\n`).join(""); }
        } else {
            const res=getElements(); if(!res.length) return;
            title=getTitle(); fname=makeFilename(title,Math.floor(res.length/2));
            const md=el=>toMd(el.innerHTML), txt=el=>el.textContent.trim();
            if(fmt==="json")     { c=JSON.stringify(res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a.push({q:md(x),a:md(res[i+1])});return a;},[]),null,2); m="application/json"; }
            else if(fmt==="csv") { c="Q,A\n"+res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`"${md(x).replace(/"/g,'""')}","${md(res[i+1]).replace(/"/g,'""')}"\n`;return a;},""); m="text/csv"; }
            else if(fmt==="html"){ c=`<html><body style="font-family:sans-serif;max-width:800px;margin:auto;padding:30px;line-height:1.7;">${res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`<div style="background:#f4f4f5;padding:15px;border-radius:12px;margin:20px 0;"><b>Q:</b> ${x.innerHTML}</div><div><b>A:</b> ${res[i+1].innerHTML}</div><hr/>`;return a;},"")}</body></html>`; m="text/html"; }
            else if(fmt==="md")  { c=res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`\n# Q:\n${md(x)}\n\n# A:\n${md(res[i+1])}\n\n---\n`;return a;},""); m="text/markdown"; }
            else                 { c=res.reduce((a,x,i)=>{if(i%2===0&&res[i+1])a+=`\nQ:\n${txt(x)}\n\nA:\n${txt(res[i+1])}\n\n---\n`;return a;},""); }
        }
        const u=URL.createObjectURL(new Blob([c.replace(/&amp;/g,"&")],{type:m}));
        const a=Object.assign(document.createElement("a"),{href:u,download:`${fname}.${fmt}`});
        document.body.appendChild(a); a.click();
        setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(u);},0);
    }

    // ─── Obsidian export ──────────────────────────────────────────────────────────
    // Opens obsidian:// tab with active:false so chat tab stays focused.
    // Tab is auto-closed after CFG.obsTabCloseMs ms (default 1500).
    async function obsidianExport() {
        let body="",title,pairs;
        if(P==="deepseek") {
            const items=await getDeepSeekContents(); if(!items.length){alert("No conversation found!");return;}
            title=getTitle(); pairs=items.filter(x=>x.role==='user').length;
            for(let i=0;i<items.length-1;i++) if(items[i].role==='user'&&items[i+1]?.role==='assistant')
                body+=`# Q:\n${items[i].text}\n\n# A:\n${items[i+1].text}\n\n---\n\n`;
        } else {
            const res=getElements(); if(!res.length){alert("No conversation found!");return;}
            title=getTitle(); pairs=Math.floor(res.length/2);
            res.forEach((el,i)=>{
                if(i%2===0&&res[i+1]){
                    const attaches=extractAttachments(el);
                    body+=`# Q:\n${toMd(el.innerHTML)}\n`;
                    if(attaches.length) body+=renderAttachmentsMd(attaches);
                    body+=`\n# A:\n${toMd(res[i+1].innerHTML)}\n\n---\n\n`;
                }
            });
        }
        const fname=makeFilename(title,pairs);
        const yaml=["---",`title: "${title}"`,`date: "${new Date().toISOString()}"`,`source: ${P}`,`url: "${document.URL}"`,`turns: ${pairs}`,"tags:","  - chat",`  - ${P}`,"---",""].join("\n")+"\n";
        GM_setClipboard(yaml+body.replace(/&amp;/g,"&"));
        const folder=encodeURIComponent(CFG.obsFolder+"/"+P);
        const obsUrl=`obsidian://new?file=${folder}%2F${encodeURIComponent(fname)}&clipboard`;

        // ── Try silent relay first (lance-relay.js on localhost:27184) ──
        // If relay is running: POST → relay calls open(obsidian://) at OS level.
        // Zero tabs opened, zero focus change, stays on chat page.
        // If relay is offline: falls back to GM_openInTab (old behaviour).
        GM_xmlhttpRequest({
            method:  'POST',
            url:     'http://127.0.0.1:27184/obsidian',
            headers: {'Content-Type':'application/json'},
            data:    JSON.stringify({uri: obsUrl}),
            timeout: 1500,
            onload(r) {
                try {
                    const res=JSON.parse(r.responseText);
                    if(res.ok) return; // relay succeeded — nothing else to do
                } catch(_) {}
                // relay responded but returned an error — fall back
                _obsidianTabFallback(obsUrl);
            },
            onerror()   { _obsidianTabFallback(obsUrl); },
            ontimeout() { _obsidianTabFallback(obsUrl); },
        });
    }

    // Fallback: open obsidian:// in a new tab (old behaviour, focus loss possible)
    function _obsidianTabFallback(obsUrl) {
        const tab=GM_openInTab(obsUrl,{active:false,insert:true});
        if(CFG.obsTabCloseMs>0 && tab && typeof tab.close==="function")
            setTimeout(()=>tab.close(), CFG.obsTabCloseMs);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ENTER-AS-NEWLINE  (ported from AI Enter as Newline v1.2.3)
    //  Enter = newline in chat input; Ctrl/Cmd/Meta+Enter = send
    // ═══════════════════════════════════════════════════════════════════════════
    function getEventTarget(e) { return e.composedPath?e.composedPath()[0]||e.target:e.target; }
    function isComposing(e)    { return e.isComposing||e.keyCode===229; }
    function isEditableTarget(t) {
        return /INPUT|TEXTAREA|SELECT/.test(t.tagName)||
               (t.getAttribute&&t.getAttribute("contenteditable")==="true");
    }
    function isChatGPTTarget(t) {
        return t.id==="prompt-textarea"||t.closest("#prompt-textarea")||
               (t.getAttribute&&t.getAttribute("contenteditable")==="true");
    }
    function isSendShortcut(e) {
        if(e.key!=="Enter") return false;
        const sc=CFG.shortcuts;
        return (sc.ctrl&&e.ctrlKey&&!e.altKey&&!e.metaKey)||
               (sc.alt&&e.altKey&&!e.ctrlKey&&!e.metaKey)||
               (sc.meta&&e.metaKey&&!e.ctrlKey&&!e.altKey);
    }
    function isPotentialSend(e) {
        if(e.key!=="Enter") return false;
        return (e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey)||
               (e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey)||
               (e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey);
    }
    function findSubmit() {
        if(P==="chatGPT") return qs('button[data-testid="send-button"]');
        if(P==="gemini")  return qs('button[aria-label*="Send"],button[aria-label*="发送"],button[aria-label*="傳送"]');
        if(P==="deepseek"){
            const bc=qs(".bf38813a"); if(!bc) return null;
            const btns=qsa('.ds-icon-button[role="button"]',bc);
            for(let i=btns.length-1;i>=0;i--){
                const b=btns[i];
                if(b.getAttribute("aria-disabled")!=="true"&&!b.classList.contains("ds-icon-button--disabled")) return b;
            }
        }
        if(P==="claude") return qs('button[aria-label*="Send"]');
        if(P==="grok")   return qs('button[type="submit"]');
        return null;
    }

    window.addEventListener("keydown", e => {
        if(isComposing(e)) return;
        const t=getEventTarget(e);

        // ── ChatGPT ──
        if(P==="chatGPT") {
            if(e.key==="Enter"&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey&&!e.altKey&&isChatGPTTarget(t)){
                e.stopPropagation(); e.preventDefault();
                const ev=new KeyboardEvent("keydown",{key:"Enter",code:"Enter",shiftKey:true,bubbles:true,cancelable:true});
                t.dispatchEvent(ev);
                if(!ev.defaultPrevented) document.execCommand("insertParagraph");
                return;
            }
            if(isSendShortcut(e)&&isChatGPTTarget(t)){
                const sb=findSubmit(); if(sb&&!sb.disabled){e.preventDefault();e.stopPropagation();sb.click();} return;
            }
            if(isPotentialSend(e)&&isChatGPTTarget(t)){e.preventDefault();e.stopPropagation();}
            return;
        }

        // ── All other platforms ──
        if(e.key==="Enter"&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey&&!e.altKey&&isEditableTarget(t)){
            e.preventDefault(); e.stopPropagation();
            if(t.tagName==="TEXTAREA"){
                const s=t.selectionStart,v=t.value;
                t.value=v.substring(0,s)+"\n"+v.substring(t.selectionEnd);
                t.selectionStart=t.selectionEnd=s+1;
                t.dispatchEvent(new Event("input",{bubbles:true}));
            } else {
                const ev=new KeyboardEvent("keydown",{key:"Enter",code:"Enter",shiftKey:true,bubbles:true,cancelable:true});
                t.dispatchEvent(ev);
                if(!ev.defaultPrevented) document.execCommand("insertParagraph");
            }
            return;
        }
        if(isSendShortcut(e)&&isEditableTarget(t)){
            const sb=findSubmit(); if(sb&&!sb.disabled){e.preventDefault();e.stopPropagation();sb.click();} return;
        }
        if(isPotentialSend(e)&&isEditableTarget(t)){e.stopPropagation();}
    }, true);

    window.addEventListener("keypress", e => {
        if(P==="chatGPT"||isComposing(e)) return;
        if(e.key==="Enter"&&!e.ctrlKey&&!e.shiftKey&&!e.metaKey&&!e.altKey){
            const t=getEventTarget(e);
            if(isEditableTarget(t)) e.stopPropagation();
        }
        if(isPotentialSend(e)){
            const t=getEventTarget(e);
            if(isEditableTarget(t)) e.stopPropagation();
        }
    }, true);

    // ═══════════════════════════════════════════════════════════════════════════
    //  SETTINGS DASHBOARD
    // ═══════════════════════════════════════════════════════════════════════════
    function openDashboard() {
        const existing=qs('#lance-dashboard');
        if(existing){existing.remove();qs('#lance-overlay')?.remove();return;}

        const isDark=window.matchMedia('(prefers-color-scheme:dark)').matches;
        const bg  = isDark?"#1e1e22":"#ffffff";
        const fg  = isDark?"#e4e4e8":"#222222";
        const bd  = isDark?"#333338":"#dddddd";
        const sbg = isDark?"#2a2a30":"#f5f5f7";
        const acc = "#7c3aed";

        // Overlay
        const ov=document.createElement('div');
        ov.id='lance-overlay';
        Object.assign(ov.style,{position:'fixed',inset:'0',background:isDark?'rgba(0,0,0,0.7)':'rgba(0,0,0,0.45)',zIndex:'2147483645'});
        ov.onclick=()=>{ov.remove();dlg.remove();};
        document.body.appendChild(ov);

        // Dialog
        const dlg=document.createElement('div');
        dlg.id='lance-dashboard';
        Object.assign(dlg.style,{
            position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',
            background:bg,color:fg,border:`1px solid ${bd}`,borderRadius:'12px',
            padding:'24px',width:'360px',maxWidth:'92vw',maxHeight:'88vh',
            overflowY:'auto',zIndex:'2147483646',
            fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            fontSize:'14px',boxShadow:'0 16px 48px rgba(0,0,0,0.35)',
        });

        const row=(a,b)=>{
            const d=document.createElement('div');
            Object.assign(d.style,{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:`1px solid ${bd}`});
            const la=document.createElement('span'); la.textContent=a; la.style.color=fg;
            d.appendChild(la);
            if(b) d.appendChild(b);
            return d;
        };
        const toggle=(val,onChange)=>{
            const lbl=document.createElement('label');
            Object.assign(lbl.style,{position:'relative',display:'inline-block',width:'36px',height:'20px',flexShrink:'0'});
            const inp=document.createElement('input'); inp.type='checkbox'; inp.checked=val;
            Object.assign(inp.style,{opacity:'0',width:'0',height:'0',position:'absolute'});
            const sl=document.createElement('span');
            Object.assign(sl.style,{position:'absolute',inset:'0',borderRadius:'20px',cursor:'pointer',
                background:val?acc:bd,transition:'background 0.2s'});
            const dot=document.createElement('span');
            Object.assign(dot.style,{position:'absolute',height:'14px',width:'14px',left:val?'19px':'3px',
                bottom:'3px',background:'#fff',borderRadius:'50%',transition:'left 0.2s'});
            sl.appendChild(dot);
            inp.onchange=()=>{
                const v=inp.checked;
                sl.style.background=v?acc:bd; dot.style.left=v?'19px':'3px';
                onChange(v);
            };
            lbl.appendChild(inp); lbl.appendChild(sl);
            return lbl;
        };
        const section=(title)=>{
            const d=document.createElement('div');
            Object.assign(d.style,{fontSize:'11px',fontWeight:'700',letterSpacing:'0.08em',
                textTransform:'uppercase',color:isDark?'rgba(255,255,255,0.35)':'rgba(0,0,0,0.4)',
                padding:'16px 0 6px'});
            d.textContent=title; return d;
        };

        // Header
        const hdr=document.createElement('div');
        Object.assign(hdr.style,{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'4px'});
        const htitle=document.createElement('h2');
        htitle.textContent='lance'; Object.assign(htitle.style,{margin:'0',fontSize:'18px',fontWeight:'700',color:fg});
        const ver=document.createElement('span');
        ver.textContent='v4.0.0'; Object.assign(ver.style,{fontSize:'11px',opacity:'0.4',marginLeft:'6px'});
        htitle.appendChild(ver);
        const closeBtn=document.createElement('button');
        closeBtn.textContent='✕';
        Object.assign(closeBtn.style,{background:'none',border:'none',color:fg,cursor:'pointer',fontSize:'18px',padding:'0'});
        closeBtn.onclick=()=>{dlg.remove();ov.remove();};
        hdr.appendChild(htitle); hdr.appendChild(closeBtn);
        dlg.appendChild(hdr);

        // ── Section: Sites ──
        dlg.appendChild(section('Export Button — Sites'));
        const SITE_LABELS={chatGPT:'ChatGPT',grok:'Grok',gemini:'Gemini',claude:'Claude',deepseek:'DeepSeek',yuanbao:'Yuanbao'};
        Object.entries(SITE_LABELS).forEach(([key,label])=>{
            const t=toggle(CFG.sites[key]??true, v=>{ CFG.sites[key]=v; saveCfg(CFG); });
            dlg.appendChild(row(label,t));
        });

        // ── Section: Keyboard ──
        dlg.appendChild(section('Send Shortcut (+ Enter)'));
        [['ctrl','Ctrl + Enter'],['meta','Cmd / Win + Enter'],['alt','Alt / Option + Enter']].forEach(([key,label])=>{
            const t=toggle(CFG.shortcuts[key]??DEFAULTS.shortcuts[key], v=>{ CFG.shortcuts[key]=v; saveCfg(CFG); });
            dlg.appendChild(row(label,t));
        });

        // ── Section: Obsidian ──
        dlg.appendChild(section('Obsidian'));

        // Relay status (live check)
        const relayRow=document.createElement('div');
        Object.assign(relayRow.style,{padding:'8px 0',borderBottom:`1px solid ${bd}`,display:'flex',justifyContent:'space-between',alignItems:'center'});
        const relayLbl=document.createElement('span'); relayLbl.textContent='lance-relay status'; relayLbl.style.color=fg;
        const relayStatus=document.createElement('span');
        relayStatus.textContent='checking…'; Object.assign(relayStatus.style,{fontSize:'12px',opacity:'0.6'});
        relayRow.appendChild(relayLbl); relayRow.appendChild(relayStatus);
        dlg.appendChild(relayRow);
        // Ping relay
        GM_xmlhttpRequest({method:'GET',url:'http://127.0.0.1:27184/obsidian',timeout:1000,
            onload(){ relayStatus.textContent='🟢 online'; relayStatus.style.opacity='1'; },
            onerror(){ relayStatus.textContent='🔴 offline — using tab fallback'; },
            ontimeout(){ relayStatus.textContent='🔴 offline — using tab fallback'; },
        });
        Object.assign(folderRow.style,{padding:'8px 0',borderBottom:`1px solid ${bd}`});
        const folderLbl=document.createElement('div');
        folderLbl.textContent='Vault folder (e.g. Chat)';
        Object.assign(folderLbl.style,{marginBottom:'6px',color:fg,fontSize:'13px'});
        const folderInp=document.createElement('input');
        folderInp.value=CFG.obsFolder;
        Object.assign(folderInp.style,{width:'100%',boxSizing:'border-box',padding:'6px 10px',
            background:sbg,border:`1px solid ${bd}`,borderRadius:'6px',color:fg,fontSize:'13px'});
        folderInp.oninput=()=>{ CFG.obsFolder=folderInp.value.trim()||"Chat"; saveCfg(CFG); };
        folderRow.appendChild(folderLbl); folderRow.appendChild(folderInp);
        dlg.appendChild(folderRow);

        // Tab close delay
        const closeRow=document.createElement('div');
        Object.assign(closeRow.style,{padding:'8px 0',borderBottom:`1px solid ${bd}`,display:'flex',justifyContent:'space-between',alignItems:'center'});
        const closeLbl=document.createElement('span');
        closeLbl.textContent='Fallback tab close delay (ms, 0=off)'; closeLbl.style.color=fg;
        const closeInp=document.createElement('input');
        closeInp.type='number'; closeInp.min='0'; closeInp.max='10000'; closeInp.step='100';
        closeInp.value=CFG.obsTabCloseMs;
        Object.assign(closeInp.style,{width:'72px',padding:'5px 8px',background:sbg,
            border:`1px solid ${bd}`,borderRadius:'6px',color:fg,fontSize:'13px',textAlign:'right'});
        closeInp.oninput=()=>{ CFG.obsTabCloseMs=Math.max(0,parseInt(closeInp.value)||0); saveCfg(CFG); };
        closeRow.appendChild(closeLbl); closeRow.appendChild(closeInp);
        dlg.appendChild(closeRow);

        // Footer note
        const note=document.createElement('p');
        note.textContent='All settings auto-save on change.';
        Object.assign(note.style,{margin:'16px 0 0',fontSize:'11px',opacity:'0.4',textAlign:'center'});
        dlg.appendChild(note);

        document.body.appendChild(dlg);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  STYLES
    // ═══════════════════════════════════════════════════════════════════════════
    GM_addStyle(`
        .ai-export-drag-box {
            position:fixed;z-index:2147483646;display:flex;flex-direction:column;
            align-items:center;justify-content:center;
            background:rgba(28,28,30,0.88);backdrop-filter:blur(12px);
            color:#fff;border-radius:100px;box-shadow:0 8px 32px rgba(0,0,0,0.25);
            cursor:move;user-select:none;border:1px solid rgba(255,255,255,0.1);
            padding:10px 20px;font-family:system-ui;font-size:14px;font-weight:600;
            transition:transform 0.2s ease;white-space:nowrap;
        }
        .ai-export-drag-box:hover{transform:scale(1.05);}
        .ai-export-menu-panel{
            position:absolute;width:max-content;min-width:180px;
            background:#1c1c20;border:1px solid rgba(255,255,255,0.08);
            border-radius:14px;padding:5px;display:none;flex-direction:column;gap:1px;
        }
        .pos-bottom-right{bottom:calc(100% + 14px);right:0;transform-origin:bottom right;animation:aiPopUp .25s cubic-bezier(.16,1,.3,1);box-shadow:0 -8px 40px rgba(0,0,0,.5);}
        .pos-bottom-left {bottom:calc(100% + 14px);left:0; transform-origin:bottom left; animation:aiPopUp .25s cubic-bezier(.16,1,.3,1);box-shadow:0 -8px 40px rgba(0,0,0,.5);}
        .pos-top-right   {top:calc(100% + 14px);   right:0;transform-origin:top right;   animation:aiPopDown .25s cubic-bezier(.16,1,.3,1);box-shadow:0 8px 40px rgba(0,0,0,.5);}
        .pos-top-left    {top:calc(100% + 14px);   left:0; transform-origin:top left;    animation:aiPopDown .25s cubic-bezier(.16,1,.3,1);box-shadow:0 8px 40px rgba(0,0,0,.5);}
        @keyframes aiPopUp   {0%{opacity:0;transform:scale(.9) translateY(8px) }100%{opacity:1;transform:scale(1) translateY(0)}}
        @keyframes aiPopDown {0%{opacity:0;transform:scale(.9) translateY(-8px)}100%{opacity:1;transform:scale(1) translateY(0)}}
        .ai-export-menu-item{
            display:flex;align-items:center;padding:10px 13px;
            background:transparent;border:none;border-radius:9px;text-align:left;
            cursor:pointer;color:#e4e4e8;font-size:13px;font-weight:500;
            transition:background .12s,color .12s,transform .1s;width:100%;white-space:nowrap;
        }
        .ai-export-menu-item:hover          {background:rgba(80,220,160,.12);color:#5ee3a6;}
        .ai-export-menu-item.obsidian:hover {background:rgba(124,58,237,.12);color:#a89ef5;}
        .ai-export-menu-item.settings:hover {background:rgba(255,255,255,.07);color:#fff;}
        .ai-export-menu-item:active,
        .ai-export-menu-item.clicked        {transform:scale(.94);opacity:.7;}
        .ai-export-menu-divider{height:1px;background:rgba(255,255,255,.07);margin:3px 7px;}
        .ai-export-section-label{
            font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
            color:rgba(255,255,255,.28);padding:6px 13px 2px;
        }
        .ai-export-badge{margin-left:auto;font-size:10px;font-weight:700;letter-spacing:.04em;font-family:monospace;opacity:.38;}
    `);

    // ─── UI init ─────────────────────────────────────────────────────────────────
    function init() {
        // Respect per-site toggle
        if(CFG.sites[P]===false) { qs('.ai-export-drag-box')?.remove(); return; }
        if(qs('.ai-export-drag-box')) return;

        const box=mkEl("div",{className:"ai-export-drag-box"});
        box.innerHTML=`<div style="display:flex;align-items:center;gap:8px;pointer-events:none;">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            <span>Export</span>
        </div>`;
        const menu=mkEl("div",{className:"ai-export-menu-panel"});

        const addLabel=t=>menu.appendChild(Object.assign(document.createElement('div'),{className:'ai-export-section-label',textContent:t}));
        const addDiv=()=>menu.appendChild(mkEl("div",{className:"ai-export-menu-divider"}));
        const addBtn=(icon,label,badge,cls,fn)=>{
            const btn=mkEl("button",{className:`ai-export-menu-item${cls?' '+cls:''}`});
            btn.innerHTML=`<span style="font-family:monospace;font-size:11px;width:18px;text-align:center;opacity:.5;flex-shrink:0">${icon}</span><span style="margin-left:2px">${label}</span><span class="ai-export-badge">${badge}</span>`;
            btn.onclick=e=>{e.stopPropagation();btn.classList.add('clicked');setTimeout(()=>{btn.classList.remove('clicked');menu.style.display='none';fn();},180);};
            menu.appendChild(btn);
        };

        addLabel("Download");
        addBtn('#', 'Markdown',   '.MD',   '',         ()=>fileExport('md'));
        addBtn('{}','JSON',       '.JSON', '',         ()=>fileExport('json'));
        addBtn(',', 'CSV',        '.CSV',  '',         ()=>fileExport('csv'));
        addBtn('T', 'Plain text', '.TXT',  '',         ()=>fileExport('txt'));
        addBtn('<>','HTML',       '.HTML', '',         ()=>fileExport('html'));
        addDiv();
        addLabel("Integrations");
        addBtn('◆', 'Obsidian',  '.MD',   'obsidian', ()=>obsidianExport());
        addDiv();
        addBtn('⚙', 'Settings',  '',      'settings', ()=>openDashboard());

        box.appendChild(menu);
        document.body.appendChild(box);

        const sX=GM_getValue('x',window.innerWidth-160), sY=GM_getValue('y',window.innerHeight-100);
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

    // GM menu — settings only, no obsidian shortcut
    GM_registerMenuCommand("⚙ lance settings", openDashboard);

    if(typeof trustedTypes!=="undefined"&&trustedTypes.defaultPolicy===null)
        trustedTypes.createPolicy("default",{createHTML:s=>s,createScriptURL:s=>s,createScript:s=>s});

    setTimeout(init,1000);
    setInterval(init,3000);
})();
