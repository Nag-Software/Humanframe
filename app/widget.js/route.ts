import { appOrigin } from "@/agent/lib/email-template";

/**
 * The embed script. A business pastes one line on its site:
 *
 *   <script src="https://<app>/widget.js" data-key="…" async></script>
 *
 * It draws a launcher and opens the conversation in an iframe from our
 * origin, so nothing of ours runs in the business's page beyond this file
 * and no cookie or storage of theirs is touched.
 */
export function GET() {
  const origin = appOrigin() ?? "";
  const script = `(()=>{try{
var s=document.currentScript||document.querySelector('script[data-key][src*="widget.js"]');if(!s)return;
var key=s.getAttribute('data-key');if(!key||window.__humanframe)return;window.__humanframe=1;
var origin=${JSON.stringify(origin)}||new URL(s.src).origin;
var color=s.getAttribute('data-color')||'#24493F';var label=s.getAttribute('data-label')||'Send forespørsel';
var root=document.createElement('div');root.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
var btn=document.createElement('button');btn.type='button';btn.setAttribute('aria-label',label);
btn.style.cssText='display:flex;align-items:center;gap:10px;border:0;cursor:pointer;background:'+color+';color:#fff;padding:13px 18px 13px 14px;border-radius:999px;font-size:15px;font-weight:600;box-shadow:0 10px 30px -10px rgba(20,18,15,.45),0 2px 6px rgba(20,18,15,.12)';
btn.innerHTML='<svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M11 9.5H9.5A1.5 1.5 0 0 0 8 11v10a1.5 1.5 0 0 0 1.5 1.5H11M21 9.5h1.5A1.5 1.5 0 0 1 24 11v10a1.5 1.5 0 0 1-1.5 1.5H21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="#D9B87A"/></svg><span></span>';
btn.querySelector('span').textContent=label;
var frame=document.createElement('iframe');frame.title=label;frame.src=origin+'/w/'+encodeURIComponent(key)+'?embed=1&origin='+encodeURIComponent(location.href);
frame.allow='clipboard-write';
frame.style.cssText='display:none;width:min(400px,calc(100vw - 24px));height:min(640px,calc(100vh - 100px));border:0;border-radius:20px;background:#F7F5F0;box-shadow:0 30px 60px -20px rgba(20,18,15,.35),0 0 0 1px rgba(20,18,15,.08);margin-bottom:12px';
var open=false;function toggle(v){open=v===undefined?!open:v;frame.style.display=open?'block':'none';btn.style.display=open&&window.innerWidth<520?'none':'flex';}
btn.addEventListener('click',function(){toggle();});
window.addEventListener('message',function(e){if(e.origin!==origin)return;if(e.data==='humanframe:close')toggle(false);});
root.appendChild(frame);root.appendChild(btn);document.body.appendChild(root);
}catch(e){}})();`;
  return new Response(script, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
