/* assets.js — logo, receipt-logo and signature uploads; pushing the profile to the server.
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
// ── logo upload (downscaled to a data-URL) ───────────────────────
const LOGO_MAX = 320;         // px — longest edge; keeps the stored string small
const LOGO_MAX_BYTES = 180000; // ~180KB data-URL ceiling (server caps at 200KB)

// Read a File, downscale via canvas, return a data-URL. SVGs pass through as-is
// (vector — no raster step) but are still size-checked.
function fileToLogo(file){
  return new Promise((resolve, reject) => {
    if(!file) return reject(new Error("no file"));
    if(!/^image\//.test(file.type)) return reject(new Error("Please choose an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    if(file.type === "image/svg+xml"){
      reader.onload = () => {
        const s = String(reader.result||"");
        if(s.length > LOGO_MAX_BYTES) return reject(new Error("SVG is too large (max ~180KB)."));
        resolve(s);
      };
      return reader.readAsDataURL(file);
    }
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image couldn't be loaded."));
      img.onload = () => {
        const scale = Math.min(1, LOGO_MAX/Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width*scale));
        const h = Math.max(1, Math.round(img.height*scale));
        const c = document.createElement("canvas"); c.width=w; c.height=h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        // PNG preserves transparency; good default for logos.
        let out = c.toDataURL("image/png");
        if(out.length > LOGO_MAX_BYTES) out = c.toDataURL("image/jpeg", 0.85); // fallback: smaller
        if(out.length > LOGO_MAX_BYTES) return reject(new Error("Logo is too large after resizing. Try a simpler image."));
        resolve(out);
      };
      img.src = String(reader.result||"");
    };
    reader.readAsDataURL(file);
  });
}

// Reflect BIZ_LOGO into a thumbnail + buttons. Runs for BOTH the main business
// form (logo*) and the settings modal (setLogo*), since either may be present.
function syncLogoUI(){
  [["logoPreview","logoPlaceholder","logoClear"],
   ["setLogoPreview","setLogoPlaceholder","setLogoClear"]].forEach(([pv,ph,cl])=>{
    const img=$(pv); if(!img) return;
    const place=$(ph), clr=$(cl);
    const src = safeImgSrc(BIZ_LOGO);
    if(src){ img.src=src; img.hidden=false; place.hidden=true; clr.hidden=false; }
    else { img.hidden=true; place.hidden=false; clr.hidden=true; }
  });
}

// Wire one pick/file/clear trio to the shared BIZ_LOGO. Both the main form and
// the settings modal call this with their own element ids.
function wireLogoTrio(pickId, fileId, clrId){
  const pick=$(pickId), file=$(fileId), clr=$(clrId);
  if(!pick) return;
  pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0];
    file.value = ""; // allow re-picking the same file
    if(!f) return;
    try{
      BIZ_LOGO = await fileToLogo(f);
      saveBiz(); syncLogoUI(); render();
      if(ME) persistLogo();   // logged in → also save to the account
    }catch(e){ alert(e.message || "Could not use that logo."); }
  };
  clr.onclick = () => {
    BIZ_LOGO = ""; saveBiz(); syncLogoUI(); render();
    if(ME) persistLogo();
  };
}

function wireLogo(){
  wireLogoTrio("logoPick", "logoFile", "logoClear");        // main business form
  wireLogoTrio("setLogoPick", "setLogoFile", "setLogoClear"); // settings modal
  wireSignTrio("signPick", "signFile", "signClear");          // main business form
  wireSignTrio("setSignPick", "setSignFile", "setSignClear"); // settings modal
  wireReceiptLogoTrio("rlogoPick", "rlogoFile", "rlogoClear");
  wireReceiptLogoTrio("setRlogoPick", "setRlogoFile", "setRlogoClear");
}

/* ── the authorised signatory's signature ─────────────────────────

   Stored as a 1-bit mask, "<w>:<h>:<base64>", packed HERE rather than sent as
   an image. Two reasons, both in src/signature.js at length: the Worker would
   otherwise need a PNG decoder (an inflater) purely to find the ink, and one
   bit per pixel is what makes the PDF and the thermal receipt render the same
   marks rather than each thresholding a greyscale image its own way. */

/* The receipt's own logo, as a 1-bit mask.

   Same format and same parser as the signature. What differs is which pixels
   count as ink, and that is the whole reason this exists separately from
   biz_logo: Aswin's mark is cyan on BLACK, so the ordinary rule — ink is what is
   dark — burned the entire background and printed a solid square at 100% ink.

   So the polarity is decided per image rather than assumed. A mostly-dark image
   is light-on-dark artwork and its BRIGHT pixels are the mark; a mostly-light
   one is ordinary and its dark pixels are. Then it is trimmed to the ink, so
   "22mm wide" means 22mm of logo rather than 22mm of surrounding canvas. */
let RECEIPT_LOGO = "";

const LOGO_MM = 22;            // chosen on paper against 5 sizes
const LOGO_MAXMM = 20;         // height ceiling, so a tall mark cannot eat the roll
const LOGO_MAXPX = 512;

function fileToReceiptLogo(file){
  return new Promise((resolve, reject) => {
    if(!file) return reject(new Error("no file"));
    if(!/^image\//.test(file.type)) return reject(new Error("Please choose an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image couldn't be loaded."));
      img.onload = () => {
        const s0 = Math.min(1, LOGO_MAXPX/Math.max(img.width, img.height));
        const w0 = Math.max(1, Math.round(img.width*s0));
        const h0 = Math.max(1, Math.round(img.height*s0));
        const c0 = document.createElement("canvas"); c0.width=w0; c0.height=h0;
        const x0 = c0.getContext("2d");
        x0.fillStyle = "#fff"; x0.fillRect(0,0,w0,h0);
        x0.drawImage(img, 0, 0, w0, h0);
        const d = x0.getImageData(0,0,w0,h0).data;

        const lum = (i) => 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        let sum = 0;
        for(let i=0;i<d.length;i+=4) sum += lum(i);
        const mean = sum/(w0*h0);
        // Mostly dark canvas -> the artwork is the light part.
        const isInk = mean < 110 ? (i) => lum(i) > 60 : (i) => lum(i) < SIGN_THRESHOLD;

        let minX=w0,minY=h0,maxX=-1,maxY=-1;
        for(let y=0;y<h0;y++) for(let x=0;x<w0;x++){
          if(!isInk((y*w0+x)*4)) continue;
          if(x<minX)minX=x; if(x>maxX)maxX=x;
          if(y<minY)minY=y; if(y>maxY)maxY=y;
        }
        if(maxX<0) return reject(new Error("That image has nothing to print — no mark could be found in it."));

        const cw = maxX-minX+1, ch = maxY-minY+1;
        /* Scale the trimmed mark to LOGO_MM, upscaling if the artwork is small
           — a mark cropped out of a 320px logo is only ~146px and would
           otherwise print at 18mm. Capped at 2x, past which it is only blur,
           and capped in height so a tall mark cannot eat the roll. */
        let scale = Math.min(2, (LOGO_MM*8)/cw);
        if(ch*scale > LOGO_MAXMM*8) scale = (LOGO_MAXMM*8)/ch;
        const w = Math.max(1, Math.round(cw*scale)), h = Math.max(1, Math.round(ch*scale));
        const c = document.createElement("canvas"); c.width=w; c.height=h;
        const ctx = c.getContext("2d");
        ctx.fillStyle="#fff"; ctx.fillRect(0,0,w,h);
        ctx.drawImage(c0, minX, minY, cw, ch, 0, 0, w, h);
        const p2 = ctx.getImageData(0,0,w,h).data;
        const lum2 = (i) => 0.299*p2[i] + 0.587*p2[i+1] + 0.114*p2[i+2];
        const ink2 = mean < 110 ? (i) => lum2(i) > 60 : (i) => lum2(i) < SIGN_THRESHOLD;

        const stride=(w+7)>>3, bits=new Uint8Array(stride*h);
        for(let y=0;y<h;y++) for(let x=0;x<w;x++)
          if(ink2((y*w+x)*4)) bits[y*stride+(x>>3)] |= 1<<(7-(x&7));
        let bin=""; for(let i=0;i<bits.length;i++) bin+=String.fromCharCode(bits[i]);
        resolve(`${w}:${h}:${btoa(bin)}`);
      };
      img.src = String(reader.result||"");
    };
    reader.readAsDataURL(file);
  });
}

let _logoCache = { key:"", url:"", ratio:1 };
function receiptLogoUrl(){
  const mask = RECEIPT_LOGO;
  if(!mask) return "";
  if(_logoCache.key === mask) return _logoCache.url;
  const m = /^(\d{1,5}):(\d{1,5}):([A-Za-z0-9+/=]+)$/.exec(mask);
  if(!m) return "";
  const w=Number(m[1]), h=Number(m[2]);
  let bin; try{ bin=atob(m[3]); }catch(_){ return ""; }
  const stride=(w+7)>>3;
  if(bin.length !== stride*h) return "";
  const c=document.createElement("canvas"); c.width=w; c.height=h;
  const ctx=c.getContext("2d"), img=ctx.createImageData(w,h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const on=(bin.charCodeAt(y*stride+(x>>3))>>(7-(x&7)))&1;
    const i=(y*w+x)*4;
    img.data[i]=img.data[i+1]=img.data[i+2]=on?0:255;
    img.data[i+3]=on?255:0;
  }
  ctx.putImageData(img,0,0);
  _logoCache={key:mask,url:c.toDataURL("image/png"),ratio:h/w};
  return _logoCache.url;
}

function syncReceiptLogoUI(){
  const url = receiptLogoUrl();
  [["rlogoPreview","rlogoPlaceholder","rlogoClear"],
   ["setRlogoPreview","setRlogoPlaceholder","setRlogoClear"]].forEach(([pv,ph,cl])=>{
    const img=$(pv); if(!img) return;
    if(url){ img.src=url; img.hidden=false; $(ph).hidden=true; $(cl).hidden=false; }
    else { img.hidden=true; $(ph).hidden=false; $(cl).hidden=true; }
  });
}

function wireReceiptLogoTrio(pickId, fileId, clrId){
  const pick=$(pickId), file=$(fileId), clr=$(clrId);
  if(!pick) return;
  pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0]; file.value = "";
    if(!f) return;
    try{
      RECEIPT_LOGO = await fileToReceiptLogo(f);
      saveBiz(); syncReceiptLogoUI(); render();
      if(ME) persistProfile();
    }catch(e){ alert(e.message || "Could not use that image."); }
  };
  clr.onclick = () => {
    RECEIPT_LOGO = ""; saveBiz(); syncReceiptLogoUI(); render();
    if(ME) persistProfile();
  };
}

const SIGN_MAX = 720;      // px on the longest edge — ~34KB packed, ~300dpi on A4
const SIGN_THRESHOLD = 176; // the printer's own cut-off, so WYSIWYG on paper

function fileToSignature(file){
  return new Promise((resolve, reject) => {
    if(!file) return reject(new Error("no file"));
    if(!/^image\//.test(file.type)) return reject(new Error("Please choose an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image couldn't be loaded."));
      img.onload = () => {
        /* Two passes, because the ink has to be FOUND before it can be sized.

           A signature exported from a phone is a small squiggle floating in a
           large transparent canvas — this one is 1399x584 of ink inside
           1536x1024. Packing that verbatim stores mostly emptiness and, worse,
           makes "36mm wide on the receipt" mean 36mm of mostly blank space with
           a small signature in the middle. So: rasterise, find the bounding box
           of the actual ink, then scale THAT to the target size. */
        const NATIVE = 1600;
        const s0 = Math.min(1, NATIVE/Math.max(img.width, img.height));
        const w0 = Math.max(1, Math.round(img.width*s0));
        const h0 = Math.max(1, Math.round(img.height*s0));
        const c0 = document.createElement("canvas"); c0.width=w0; c0.height=h0;
        const x0 = c0.getContext("2d");
        // White first: the source is ink on TRANSPARENCY, and transparency has
        // to become paper. Composite straight onto the canvas and every clear
        // pixel reads as black.
        x0.fillStyle = "#fff"; x0.fillRect(0,0,w0,h0);
        x0.drawImage(img, 0, 0, w0, h0);

        const d0 = x0.getImageData(0,0,w0,h0).data;
        const dark = (i) => (0.299*d0[i] + 0.587*d0[i+1] + 0.114*d0[i+2]) < SIGN_THRESHOLD;
        let minX=w0, minY=h0, maxX=-1, maxY=-1;
        for(let y=0; y<h0; y++){
          for(let x=0; x<w0; x++){
            if(!dark((y*w0 + x)*4)) continue;
            if(x<minX) minX=x; if(x>maxX) maxX=x;
            if(y<minY) minY=y; if(y>maxY) maxY=y;
          }
        }
        if(maxX < 0) return reject(new Error(
          "That image has no dark strokes to use — a signature needs to be dark ink on a light or transparent background."));

        // A hair of margin so the outermost stroke is not shaved by rounding.
        const pad = 2;
        minX = Math.max(0, minX-pad); minY = Math.max(0, minY-pad);
        maxX = Math.min(w0-1, maxX+pad); maxY = Math.min(h0-1, maxY+pad);
        const cw = maxX-minX+1, ch = maxY-minY+1;

        const scale = Math.min(1, SIGN_MAX/Math.max(cw, ch));
        const w = Math.max(1, Math.round(cw*scale));
        const h = Math.max(1, Math.round(ch*scale));
        const c = document.createElement("canvas"); c.width=w; c.height=h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0,0,w,h);
        ctx.drawImage(c0, minX, minY, cw, ch, 0, 0, w, h);

        const px = ctx.getImageData(0,0,w,h).data;
        const stride = (w + 7) >> 3;
        const bits = new Uint8Array(stride*h);
        for(let y=0; y<h; y++){
          for(let x=0; x<w; x++){
            const i = (y*w + x)*4;
            // Rec. 601 luma, the weighting the print pipeline's own greyscale
            // conversion uses, so what is stored is what gets printed.
            const lum = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
            if(lum < SIGN_THRESHOLD) bits[y*stride + (x>>3)] |= 1 << (7-(x&7));
          }
        }

        let bin = "";
        for(let i=0; i<bits.length; i++) bin += String.fromCharCode(bits[i]);
        resolve(`${w}:${h}:${btoa(bin)}`);
      };
      img.src = String(reader.result||"");
    };
    reader.readAsDataURL(file);
  });
}

/* The mask as something a browser can draw: a data-URL, built once and cached.

   jsPDF's addImage and an <img> both want a real image, and rebuilding this on
   every render() — which runs on each keystroke — would repaint a 720px canvas
   for nothing. */
let _signCache = { key:"", url:"" };
function signDataUrl(){
  const mask = BIZ_SIGN;
  if(!mask) return "";
  if(_signCache.key === mask) return _signCache.url;

  const m = /^(\d{1,5}):(\d{1,5}):([A-Za-z0-9+/=]+)$/.exec(mask);
  if(!m) return "";
  const w = Number(m[1]), h = Number(m[2]);
  let bin; try{ bin = atob(m[3]); }catch(_){ return ""; }
  const stride = (w + 7) >> 3;
  if(bin.length !== stride*h) return "";

  // The receipt sizes by width and needs the true proportions, or a signature
  // that is not roughly 2.4:1 comes out stretched.
  SIGN_RATIO = h / w;

  const c = document.createElement("canvas"); c.width=w; c.height=h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  for(let y=0; y<h; y++){
    for(let x=0; x<w; x++){
      const on = (bin.charCodeAt(y*stride + (x>>3)) >> (7-(x&7))) & 1;
      const i = (y*w + x)*4;
      // Ink is opaque navy; everything else is transparent, so the signature
      // sits on the sheet rather than in a white box.
      img.data[i] = on ? 13 : 255;
      img.data[i+1] = on ? 28 : 255;
      img.data[i+2] = on ? 74 : 255;
      img.data[i+3] = on ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  _signCache = { key: mask, url: c.toDataURL("image/png") };
  return _signCache.url;
}

// Both the main business form and the settings modal, since either may be on
// screen — same shape as syncLogoUI.
function syncSignUI(){
  const url = signDataUrl();
  [["signPreview","signPlaceholder","signClear"],
   ["setSignPreview","setSignPlaceholder","setSignClear"]].forEach(([pv,ph,cl])=>{
    const img=$(pv); if(!img) return;
    if(url){ img.src=url; img.hidden=false; $(ph).hidden=true; $(cl).hidden=false; }
    else { img.hidden=true; $(ph).hidden=false; $(cl).hidden=true; }
  });
}

function wireSignTrio(pickId, fileId, clrId){
  const pick=$(pickId), file=$(fileId), clr=$(clrId);
  if(!pick) return;
  pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if(!f) return;
    try{
      BIZ_SIGN = await fileToSignature(f);
      saveBiz(); syncSignUI(); render();
      if(ME) persistProfile();
    }catch(e){ alert(e.message || "Could not use that signature."); }
  };
  clr.onclick = () => {
    BIZ_SIGN = ""; saveBiz(); syncSignUI(); render();
    if(ME) persistProfile();
  };
}

// Push the current business profile (fields + logo) to the account, best-effort.
// Defaults are preserved from ME so we never blank them. No-op when signed out.
async function persistProfile(){
  if(!ME) return;
  const biz={}; BIZ_FIELDS.forEach(f=>biz[f]=$(f).value);
  biz.bizLogo=BIZ_LOGO;
  biz.qrUrl=fld("bizQrUrl");
  biz.qrCaption=fld("bizQrCaption");
  biz.bizSign=BIZ_SIGN;
  biz.receiptLogo=RECEIPT_LOGO;
  biz.upiVpa=fld("bizUpiVpa");
  biz.payQr=fld("bizPayQr");
  ME.biz = {...(ME.biz||{}), ...biz};                  // keep local mirror fresh

  // Addressed to a business, not to the account. Without the id this would edit
  // whichever one is default — so typing in the form while 3DPrints is selected
  // would quietly rewrite AswinCloud's letterhead.
  const target = activeBiz();
  const defaults = (target && target.defaults) || ME.defaults || {};
  try{
    await api("/profile",{method:"PUT",
      body:JSON.stringify({...biz, businessId: target ? target.id : null, defaults})});
    // The QR is encoded server-side, so a changed shop link only becomes
    // printable once it has been saved and read back.
    await refreshBusinesses();
    const again = activeBiz();
    if(again) BIZ_QR_CAPTION = again.biz.qrCaption || "";
    render();
  }
  catch(e){ /* non-fatal; stays in localStorage */ }
}
const persistLogo = persistProfile; // logo pick/clear reuse the same push

// Debounced variant for typing in the business form, so we don't PUT on every keystroke.
let _profileTimer=null;
function persistProfileDebounced(){
  if(!ME) return;
  clearTimeout(_profileTimer);
  _profileTimer=setTimeout(persistProfile, 800);
}
document.addEventListener("DOMContentLoaded", wireLogo);

