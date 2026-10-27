// 2026-10-27 NEWS BRIEF VIDEO: a ~1 min narrated market brief -> MP4 (1280x720), posted every 4 h to #news-brief by bot.js.
// No presenter (user's choice): headline cards with HIGH IMPACT x/10 badges on the left, the real NQ 5-min chart on the right,
// a price ticker with the user's crest (brief_logo.png, next to bot.js) at the bottom. Voice = Microsoft neural TTS (msedge-tts, free).
// Tools are installed on first use in the run (npm into brief/node_modules, ffmpeg-static), so the 15-min news checks stay light.
// makeBrief({ segments:[{say, card, sub, impact?}], ticker, candles:[{o,h,l,c,v}], last, outDir }) -> path of the MP4
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const DIR = path.join(__dirname, 'brief');
const FPS = 25, GAP = 0.35, W = 1280, H = 720;

function tools() {
  const nm = path.join(DIR, 'node_modules'), ffDir = path.join(DIR, 'ff'), npm = args => execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
  // msedge-tts has a "pnpm only" preinstall check that fails under npm, and neither package needs an install script: --ignore-scripts.
  // ffmpeg-static downloads its binary in its install script, so it goes into its own folder with scripts on.
  if (!fs.existsSync(path.join(nm, 'msedge-tts')) || !fs.existsSync(path.join(nm, '@resvg', 'resvg-js'))) { console.log('news brief: installing voice + picture tools'); npm(['--ignore-scripts', '--prefix', DIR, 'msedge-tts@2.1.1', '@resvg/resvg-js@2.6.2']); }
  if (!fs.existsSync(path.join(ffDir, 'node_modules', 'ffmpeg-static'))) { console.log('news brief: installing ffmpeg'); npm(['--prefix', ffDir, 'ffmpeg-static@5.2.0']); }
  const req = m => require(path.join(nm, m));
  return { tts: req('msedge-tts'), resvg: req('@resvg/resvg-js'), ffmpeg: require(path.join(ffDir, 'node_modules', 'ffmpeg-static')) };
}
const FONT_B = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/segoeuib.ttf'].find(fs.existsSync);
const FONT_R = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'C:/Windows/Fonts/segoeui.ttf'].find(fs.existsSync);
const ffFont = f => f.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');   // C:/x -> C\:/x for ffmpeg filter strings

// ---------- studio art (SVG -> PNG with resvg) ----------
const svg = (body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs>${defs}</defs>${body}</svg>`;
const FAM = `font-family="Segoe UI, DejaVu Sans, Arial"`;
function background(candles, last) {
  const defs = `
<radialGradient id="g" cx="0.7" cy="0.35" r="0.9"><stop offset="0" stop-color="#161616"/><stop offset="0.55" stop-color="#0a0a0a"/><stop offset="1" stop-color="#030303"/></radialGradient>
<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#151515" stop-opacity="0.92"/><stop offset="1" stop-color="#0a0a0a" stop-opacity="0.92"/></linearGradient>
<linearGradient id="scr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#111111"/><stop offset="1" stop-color="#070707"/></linearGradient>
<linearGradient id="glare" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/><stop offset="0.35" stop-color="#ffffff" stop-opacity="0.015"/><stop offset="0.36" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#1a1a1a" stroke-width="1"/></pattern>
<filter id="blur"><feGaussianBlur stdDeviation="18"/></filter><filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="4"/></filter>`;
  // the NQ 5-min chart: last ~40 candles, wicks, a smooth average, grid + price scale, volume, last-price tag
  const SX = 660, SY = 70, SW = 580, SH = 400, c = candles.slice(-40), N = Math.max(1, c.length), cw = 9, step = (SW - 90) / N;
  let lo = Math.min(...c.map(k => k.l)), hi = Math.max(...c.map(k => k.h)); if (!(hi > lo)) { lo -= 1; hi += 1; }
  const top = SY + 50, bot = SY + SH - 75, y = v => bot - (v - lo) / (hi - lo) * (bot - top), x = i => SX + 22 + i * step, vmax = Math.max(1, ...c.map(k => k.v || 0));
  let s = `<rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="18" fill="url(#scr)" stroke="#2a2a2a" stroke-width="3"/>`;
  for (let g = 0; g <= 4; ++g) { const gy = top + g * (bot - top) / 4, val = hi - g * (hi - lo) / 4;
    s += `<line x1="${SX + 14}" y1="${gy}" x2="${SX + SW - 70}" y2="${gy}" stroke="#242424" stroke-width="1" stroke-dasharray="4 6"/><text x="${SX + SW - 64}" y="${gy + 5}" ${FAM} font-size="13" fill="#6f6f6f">${Math.round(val).toLocaleString('en-US')}</text>`; }
  c.forEach((k, i) => { const up = k.c >= k.o, col = up ? '#26c29a' : '#e5534b', X = x(i), vh = (k.v || 0) / vmax * 38;
    s += `<rect x="${X - cw / 2}" y="${SY + SH - 20 - vh}" width="${cw}" height="${vh}" fill="${col}" opacity="0.18"/><line x1="${X}" y1="${y(k.h)}" x2="${X}" y2="${y(k.l)}" stroke="${col}" stroke-width="1.6" opacity="0.8"/>`
       + `<rect x="${X - cw / 2}" y="${y(Math.max(k.o, k.c))}" width="${cw}" height="${Math.max(1.5, Math.abs(y(k.o) - y(k.c)))}" rx="1.5" fill="${col}" opacity="0.85"/>`; });
  if (c.length > 1) { let e = c[0].c; const pts = c.map((k, i) => `${x(i).toFixed(1)},${y(e = e + (k.c - e) * 0.18).toFixed(1)}`).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="#38f2b6" stroke-width="6" opacity="0.18" filter="url(#soft)"/><polyline points="${pts}" fill="none" stroke="#38f2b6" stroke-width="2.5" opacity="0.9" stroke-linejoin="round"/>`; }
  const lc = c[N - 1]?.c ?? last, ly = y(lc);
  s += `<line x1="${x(N - 1)}" y1="${ly}" x2="${SX + SW - 70}" y2="${ly}" stroke="#26c29a" stroke-width="1" stroke-dasharray="3 4"/><rect x="${SX + SW - 70}" y="${ly - 11}" width="62" height="22" rx="4" fill="#26c29a"/>`
     + `<text x="${SX + SW - 65}" y="${ly + 5}" ${FAM} font-weight="700" font-size="12" fill="#04120d">${Math.round(lc).toLocaleString('en-US')}</text>`
     + `<text x="${SX + 22}" y="${SY + 32}" ${FAM} font-weight="700" font-size="16" fill="#9a9a9a">NQ  ·  5 MIN</text><rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="18" fill="url(#glare)"/>`;
  return svg(`<rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#grid)" opacity="0.5"/>${s}
<rect x="48" y="150" width="590" height="330" rx="22" fill="#38f2b6" opacity="0.10" filter="url(#blur)"/><rect x="48" y="150" width="590" height="330" rx="22" fill="url(#panel)" stroke="#1f6b56" stroke-width="2"/><rect x="48" y="150" width="8" height="330" rx="4" fill="#38f2b6"/>
<rect x="48" y="60" width="300" height="56" rx="12" fill="#0fb383"/><text x="70" y="98" ${FAM} font-weight="800" font-size="28" fill="#04120d" letter-spacing="2">MARKET BRIEF</text>
<circle cx="372" cy="88" r="9" fill="#ff4d4d"/><text x="390" y="97" ${FAM} font-weight="700" font-size="24" fill="#ff8080">LIVE</text>
<rect x="0" y="650" width="${W}" height="70" fill="#03070b"/><rect x="0" y="650" width="${W}" height="3" fill="#38f2b6"/>`, defs);
}

async function makeBrief({ segments, ticker, candles, last, outDir }) {
  const T = tools(); fs.mkdirSync(outDir, { recursive: true });
  const ff = (args, opts = {}) => execFileSync(T.ffmpeg, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, cwd: outDir, ...opts });
  const P = f => path.join(outDir, f);
  // 1) voice per segment (retry once - the TTS service drops a connection now and then)
  for (let i = 0; i < segments.length; i++) {
    let ok = false;
    for (let a = 0; a < 2 && !ok; a++) try {
      const tts = new T.tts.MsEdgeTTS(); await tts.setMetadata(process.env.BRIEF_VOICE || 'en-US-AriaNeural', T.tts.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const d = P('seg' + i); fs.mkdirSync(d, { recursive: true }); const r = await tts.toFile(d, segments[i].say, { rate: '+4%' }); segments[i].audio = r.audioFilePath || r; ok = true;
    } catch (e) { if (a) throw e; await new Promise(r => setTimeout(r, 3000)); }
  }
  // 2) join with short pauses; durations from the decoded audio length
  const dur = f => ff(['-i', f, '-f', 's16le', '-ac', '1', '-ar', '8000', '-']).length / 16000;
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(GAP), P('gap.wav')]); ff(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.4', P('lead.wav')]);
  let t = 0.4; const times = [], parts = ['lead.wav'];
  segments.forEach(s => { const d = dur(s.audio); times.push([t, t + d]); t += d + GAP; parts.push(path.relative(outDir, s.audio).replace(/\\/g, '/'), 'gap.wav'); });
  const total = t + 0.6;
  fs.writeFileSync(P('alist.txt'), parts.map(p => `file '${p}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', 'alist.txt', '-ar', '24000', '-ac', '1', 'voice.wav']);
  // 3) studio picture
  fs.writeFileSync(P('bg.png'), new T.resvg.Resvg(background(candles, last), { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng());
  // 4) cards + ticker + crest (text from files, expansion=none so % prints as it is)
  const tf = (name, txt) => { fs.writeFileSync(P(name), txt); return name; };
  const B = ffFont(FONT_B), R = ffFont(FONT_R), dt = [];
  segments.forEach((s, i) => {
    const [a] = times[i], end = i + 1 < segments.length ? times[i + 1][0] - 0.05 : total, en = `enable='between(t,${a.toFixed(2)},${end.toFixed(2)})'`;
    const al = `alpha='if(lt(t\\,${a.toFixed(2)}+0.35)\\,(t-${a.toFixed(2)})/0.35\\,1)'`;
    if (s.impact >= 7) { dt.push(`drawbox=x=86:y=178:w=250:h=42:color=${s.impact >= 8 ? '0xe5534b' : '0xf0a030'}@1:t=fill:${en}`);
      dt.push(`drawtext=fontfile='${B}':expansion=none:textfile=${tf(`imp${i}.txt`, `HIGH IMPACT  ${s.impact}/10`)}:fontsize=22:fontcolor=white:x=98:y=188:${en}`); }
    const card = String(s.card || '').toUpperCase().slice(0, 30), sub = String(s.sub || '').slice(0, 60);
    dt.push(`drawtext=fontfile='${B}':expansion=none:textfile=${tf(`card${i}.txt`, card)}:fontsize=${Math.min(48, Math.floor(450 / Math.max(1, card.length * 0.62)))}:fontcolor=white:x=86:y=240:${al}:${en}`);
    dt.push(`drawtext=fontfile='${R}':expansion=none:textfile=${tf(`sub${i}.txt`, sub)}:fontsize=${Math.min(30, Math.floor(950 / Math.max(1, sub.length)))}:fontcolor=0x9fe8cf:x=88:y=330:${al}:${en}`);
  });
  dt.push(`drawtext=fontfile='${B}':expansion=none:textfile=${tf('ticker.txt', ticker)}:fontsize=26:fontcolor=white:y=671:x='190+(w-190)-mod(t*110\\,(w-190)+tw)'`);
  dt.push(`drawbox=x=0:y=653:w=170:h=67:color=0x03070b@1:t=fill`, `drawbox=x=168:y=653:w=3:h=67:color=0x38f2b6@1:t=fill`);
  const fc = `[0:v]${dt.join(',')}[d];[2:v]scale=-1:62[lg];[d][lg]overlay=x='(168-w)/2':y=656[v]`;
  ff(['-loop', '1', '-framerate', String(FPS), '-i', 'bg.png', '-i', 'voice.wav', '-loop', '1', '-framerate', String(FPS), '-i', path.join(__dirname, 'brief_logo.png'),
    '-filter_complex', fc, '-map', '[v]', '-map', '1:a', '-t', total.toFixed(2), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', 'brief.mp4']);
  console.log(`news brief video: ${total.toFixed(1)} s, ${(fs.statSync(P('brief.mp4')).size / 1e6).toFixed(2)} MB`);
  return P('brief.mp4');
}
module.exports = { makeBrief };
