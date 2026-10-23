// FUNDAMENTALS BOT - posts an NQ fundamentals report to Discord.
// Runs on GitHub Actions (free). Secrets: GEMINI_API_KEY, DISCORD_WEBHOOK.
// Env: CRON (the schedule that fired, set by the workflow) or SLOT (manual run), DRY=1 prints instead of posting.
// Each report time has two crons (UK summer / winter time); the one that doesn't match today's UK clock exits quietly.
const fs = require('fs');
const path = require('path');

const SLOTS = {
  morning:  { uk: '07:00', title: '🌅 MORNING BRIEF',        next: '13:00 UK' },
  midday:   { uk: '13:00', title: '📊 MIDDAY',               next: 'after the 13:30 data, or 14:25 UK' },
  post1:    { uk: '13:32', title: '⚡ DATA RESULT',          next: '14:25 UK' },
  preny:    { uk: '14:25', title: '🔔 BEFORE THE NY OPEN',   next: 'after the 15:00 data, or 07:00 UK' },
  post2:    { uk: '15:02', title: '⚡ DATA RESULT',          next: 'tonight if a big company reports, or 07:00 UK' },
  earnings: { uk: '21:20', title: '📢 EARNINGS',             next: '07:00 UK' },
};
const MODELS = (process.env.MODEL || 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite').split(',');
const FEEDS = [
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5ENDX&region=US&lang=en-US',
  'https://news.google.com/rss/search?q=nasdaq+futures+when:1d&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=fed+OR+inflation+OR+treasury+yields+when:1d&hl=en-US&gl=US&ceid=US:en',
];
const COLOR = { BULLISH: 0x3fb950, BEARISH: 0xf85149, NEUTRAL: 0xf0b232 };
const DISCLAIMER = 'Educational market context only, not financial advice';

function ukNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const offset = (+p.hour - new Date().getUTCHours() + 24) % 24;   // 1 in summer time, 0 in winter
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday, offset };
}

function pickSlot(uk) {
  if (process.env.SLOT) return process.env.SLOT;
  const cron = (process.env.CRON || '').trim().split(/\s+/);
  if (cron.length < 2) return null;
  const hh = String((+cron[1] + uk.offset) % 24).padStart(2, '0'), mm = String(+cron[0]).padStart(2, '0');
  return Object.keys(SLOTS).find(k => SLOTS[k].uk === `${hh}:${mm}`) || null;
}

// free delayed prices (Yahoo). Optional: the report still works without them.
async function quote(sym) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const m = (await r.json()).chart.result[0].meta;
    if (!(m.regularMarketPrice > 0 && m.chartPreviousClose > 0)) return null;
    return { px: m.regularMarketPrice, chg: m.regularMarketPrice - m.chartPreviousClose, pct: 100 * (m.regularMarketPrice / m.chartPreviousClose - 1) };
  } catch { return null; }
}
async function marketNumbers() {
  const [nq, tnx, dxy] = await Promise.all([quote('NQ=F'), quote('^TNX'), quote('DX-Y.NYB')]);
  return { nq, tnx, dxy };
}
// free news headlines (RSS titles from the last day), so the report still has news when web search isn't available
async function headlines() {
  const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&apos;|&#39;|&#x2019;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const out = new Set();
  await Promise.all(FEEDS.map(async u => {
    try {
      const t = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      for (const m of [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10)) {
        const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1], date = (m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
        if (title && (!date || Date.now() - Date.parse(date) < 36 * 3600e3)) out.add(unesc(title));
      }
    } catch { }
  }));
  return [...out].slice(0, 40);
}
const sgn = (v, d = 0) => (v > 0 ? '+' : '') + v.toFixed(d);
function numbersText(n) {
  const out = [];
  if (n.nq) out.push(`NQ ${n.nq.px.toFixed(2)} (${sgn(n.nq.chg)} pts since the last settlement)`);
  if (n.tnx) out.push(`US 10-year yield ${n.tnx.px.toFixed(3)}% (${sgn(n.tnx.chg * 100)} bp at the last US close)`);
  if (n.dxy) out.push(`Dollar index ${n.dxy.px.toFixed(2)} (${sgn(n.dxy.pct, 2)}%)`);
  return out.join('\n') || 'not available';
}

function slotTask(slot) {
  switch (slot) {
    case 'morning': return 'MORNING BRIEF before London. Cover overnight news, today\'s US calendar (UK times, with forecasts) and the big NQ earnings this week.';
    case 'midday': return 'MIDDAY UPDATE. What changed since the morning; the next release and what result would flip the bias.';
    case 'post1': return 'DATA RESULT. If NO high-impact US release came out between 12:25 and 13:35 UK time today, return {"skip": true}. Otherwise report actual vs forecast, the immediate reaction in yields/NQ, and whether the bias changes.';
    case 'preny': return 'BEFORE THE NY OPEN (14:30 UK). Bias for the cash session, what to watch in the first hours, the next release.';
    case 'post2': return 'DATA RESULT. If NO high-impact or medium-impact US release came out between 14:55 and 15:05 UK time today, return {"skip": true}. Otherwise report actual vs forecast, the reaction, and whether the bias changes.';
    case 'earnings': return 'EARNINGS RESULT. If none of the 15 largest Nasdaq-100 companies reported results after the US close today, return {"skip": true}. Otherwise for each: EPS and revenue vs expected, guidance vs expected, after-hours move of the stock and NQ, why it moved, and the NQ bias for tomorrow.';
  }
}

// tries each model with Google web search first, then each model without it (the free tier may not allow search)
async function callGemini(system, user) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  let lastErr;
  for (const search of [true, false]) for (const model of MODELS) {
    const tag = `${model}${search ? ' + web search' : ' (no web search)'}`;
    try {
      const body = { systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature: 0.3 },
        contents: [{ role: 'user', parts: [{ text: search ? user : user + '\n\nWeb search is not available this time: work from the headlines above only, and leave out forecasts and calendar items you cannot see.' }] }] };
      if (search) body.tools = [{ google_search: {} }];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) { lastErr = new Error(`${tag}: ${r.status}`); console.log(`${tag}: ${r.status} ${JSON.stringify(j.error || j).slice(0, 1500)}`); continue; }
      const text = (j.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('\n');
      if (text.trim()) { console.log('model used: ' + tag); return text; }
      lastErr = new Error(`${tag}: empty answer`); console.log(lastErr.message);
    } catch (e) { lastErr = e; console.log(`${tag}: ${e.message}`); }
  }
  throw lastErr;
}

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in the answer');
  return JSON.parse(text.slice(a, b + 1));
}

const cut = (s, n) => (s = String(s || '')).length > n ? s.slice(0, n - 1) + '…' : s;
const impactIcon = i => /high/i.test(i) ? '🔴' : /med/i.test(i) ? '🟠' : '⚪';

function buildEmbed(slot, r, n) {
  const bias = (r.bias || 'NEUTRAL').toUpperCase(), conf = (r.confidence || '').toUpperCase();
  const parts = [];
  const nums = [];
  if (n.nq) nums.push(`**NQ** ${sgn(n.nq.chg)} pts`);
  if (n.tnx) nums.push(`**10y** ${n.tnx.px.toFixed(2)}% (${sgn(n.tnx.chg * 100)} bp)`);
  if (n.dxy) nums.push(`**DXY** ${n.dxy.px.toFixed(2)} (${sgn(n.dxy.pct, 2)}%)`);
  if (nums.length && slot !== 'earnings') parts.push(nums.join(' · '));
  if (r.result?.length) parts.push('**RESULT**\n' + r.result.map(x => '• ' + x).join('\n'));
  if (r.why?.length) parts.push('**WHY**\n' + r.why.map(x => '• ' + x).join('\n'));
  if (r.calendar?.length) parts.push('**TODAY (UK TIME)**\n' + r.calendar.map(c => `${c.time_uk || ''} ${impactIcon(c.impact)} ${c.event || ''}${c.forecast ? ` · forecast ${c.forecast}` : ''}${c.actual ? ` · actual **${c.actual}**` : ''}`).join('\n'));
  if (r.earnings?.length) parts.push('**📅 EARNINGS (big NQ companies)**\n' + r.earnings.map(e => `${e.day || ''} · **${e.company || ''}** · ${e.time_uk || ''}${e.expected_move ? ` · expected move ${e.expected_move}` : ''}`).join('\n'));
  if (r.watch?.length) parts.push('**WATCH**\n' + r.watch.map(x => '• ' + x).join('\n'));
  if (r.change?.length) parts.push('**WHAT WOULD CHANGE IT**\n' + r.change.map(x => '• ' + x).join('\n'));
  if (r.headlines?.length) parts.push('**HEADLINES**\n' + r.headlines.slice(0, 3).map(x => '• ' + x).join('\n'));
  return {
    title: cut(`${SLOTS[slot].title}${r.headline ? ': ' + r.headline : ''} · NQ bias ${bias}${conf ? ' · confidence ' + conf : ''}`, 256),
    description: cut(parts.join('\n\n'), 4000),
    color: COLOR[bias] ?? COLOR.NEUTRAL,
    footer: { text: `${DISCLAIMER} · next report ${SLOTS[slot].next}` },
    timestamp: new Date().toISOString(),
  };
}

// backup: numbers + fixed rule, no AI (only for the scheduled briefs, not for result reports)
function backupEmbed(slot, n) {
  let score = 0, used = 0;
  if (n.nq) { score += Math.sign(n.nq.chg); used++; }
  if (n.tnx) { score -= Math.sign(n.tnx.chg); used++; }
  if (n.dxy) { score -= Math.sign(n.dxy.chg); used++; }
  const bias = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';
  return {
    title: `${SLOTS[slot].title} (basic) · NQ bias ${bias}`,
    description: numbersText(n) + `\n\nRule: NQ up, yield down and dollar down each count bullish (opposite = bearish). Score ${sgn(score)} of ${used}.\nThe full AI report was not available this time.`,
    color: COLOR[bias], footer: { text: `${DISCLAIMER} · next report ${SLOTS[slot].next}` }, timestamp: new Date().toISOString(),
  };
}

async function post(embed) {
  const body = { username: 'FUNDAMENTALS', embeds: [embed] };
  if (process.env.DRY === '1') { console.log(JSON.stringify(body, null, 2)); return; }
  if (!process.env.DISCORD_WEBHOOK) throw new Error('DISCORD_WEBHOOK not set');
  const r = await fetch(process.env.DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Discord ${r.status} ${await r.text()}`);
  console.log('posted to Discord');
}

(async () => {
  const uk = ukNow();
  const slot = pickSlot(uk);
  if (!slot || !SLOTS[slot]) { console.log(`no report due (UK ${uk.time}, cron "${process.env.CRON || ''}") - other season's timer, exiting`); return; }
  console.log(`report: ${slot} · UK ${uk.weekday} ${uk.date} ${uk.time}`);
  const [n, news] = await Promise.all([marketNumbers(), headlines()]);
  console.log(`prices: ${n.nq ? 'NQ ok' : 'NQ missing'}, ${n.tnx ? '10y ok' : '10y missing'}, ${n.dxy ? 'DXY ok' : 'DXY missing'} · headlines: ${news.length}`);
  const system = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  const user = `Today is ${uk.weekday} ${uk.date}, UK time now ${uk.time}.\nReport type: ${slotTask(slot)}\n\nLatest prices (delayed, from a free feed; use these numbers rather than searching for prices):\n${numbersText(n)}\n\nToday's headlines (free news feeds):\n${news.map(h => '- ' + h).join('\n') || 'none'}\n\nSearch the web for today's news, calendar, forecasts and results. Then answer with the JSON object only.`;
  let embed;
  try {
    const r = parseJson(await callGemini(system, user));
    if (r.skip) { console.log('nothing to report for this slot today - skipped'); return; }
    embed = buildEmbed(slot, r, n);
  } catch (e) {
    console.log('AI report failed: ' + e.message);
    if (!['morning', 'midday', 'preny'].includes(slot)) return;
    embed = backupEmbed(slot, n);
  }
  await post(embed);
})().catch(e => { console.error(e); process.exit(1); });
