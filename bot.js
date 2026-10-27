// FUNDAMENTALS BOT - posts an NQ fundamentals report to Discord.
// Runs on GitHub Actions (free). Secrets: GEMINI_API_KEY, DISCORD_WEBHOOK.
// Env: CRON (the schedule that fired, set by the workflow) or SLOT (manual run), DRY=1 prints instead of posting.
// All report times are New York time (ET), so they follow the US market through both clock changes. Each has two crons
// (US summer / winter time); the one that doesn't match today's New York clock exits quietly. All times shown are New York time (ET).
const fs = require('fs');
const path = require('path');

const SLOTS = {
  morning:  { ny: '02:00', title: '🌅 MORNING BRIEF',        next: () => '08:00 ET' },
  midday:   { ny: '08:00', title: '📊 MIDDAY',               next: () => 'after any 08:30 ET data, or 09:25 ET' },
  post1:    { ny: '08:32', title: '⚡ DATA RESULT',          next: () => '09:25 ET' },
  preny:    { ny: '09:25', title: '🔔 BEFORE THE NY OPEN',   next: () => 'after any 10:00 ET data, or 02:00 ET' },
  post2:    { ny: '10:02', title: '⚡ DATA RESULT',          next: () => 'tonight if a big company reports, or 02:00 ET' },
  earnings: { ny: '16:30', title: '📢 EARNINGS',             next: () => '02:00 ET' },
  health:   { ny: '16:50', title: '🩺 BOT HEALTH',           next: () => '' },   // daily check of today's runs -> #bot-health
};
const slotUk = (name, d) => name === 'morning' ? nyToUk(nextWeekday(d), SLOTS.morning.ny) : nyToUk(d, SLOTS[name].ny);   // a report's UK time (morning = next weekday's)
const nextWeekday = d => { let x = d; do { x = addDays(x, 1); } while ([0, 6].includes(new Date(x + 'T12:00:00Z').getUTCDay())); return x; };
const REPORT_SLOTS = ['morning', 'midday', 'post1', 'preny', 'post2', 'earnings'];
const MODELS = (process.env.MODEL || 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite').split(',');
const FEEDS = [
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5ENDX&region=US&lang=en-US',
  'https://news.google.com/rss/search?q=nasdaq+futures+when:1d&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=fed+OR+inflation+OR+treasury+yields+when:1d&hl=en-US&gl=US&ceid=US:en',
];
const COLOR = { BULLISH: 0x3fb950, BEARISH: 0xf85149, NEUTRAL: 0x99aab5 };   // green / red / grey
const TIMEOUT = { feed: 15e3, ai: 150e3, discord: 20e3 };   // ms - a hung request must never keep the job running
const DISCLAIMER = 'Educational market context only, not financial advice';

function ukNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const offset = (+p.hour - new Date().getUTCHours() + 24) % 24;   // 1 in summer time, 0 in winter
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday, offset };
}

function pickSlot(uk) {
  if (process.env.SLOT === 'auto') {   // started by cron-job.org (2026-10-23: GitHub's own timer ran the 10:02 report 4 h late): the report due in the last 20 min
    console.log('started by timer (cron-job.org)');
    const now = et(), m = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
    const due = Object.keys(SLOTS).map(k => [k, m(now) - m(SLOTS[k].ny)]).filter(([, d]) => d >= 0 && d <= 15).sort((a, b) => a[1] - b[1]);
    return due.length ? due[0][0] : null;   // 15 min max: 16:30 earnings and 16:50 health stay apart
  }
  if (process.env.SLOT) return process.env.SLOT;
  const cron = (process.env.CRON || '').trim().split(/\s+/);
  if (cron.length < 2) return null;
  if (/[*/]/.test(cron[0] + cron[1])) return 'news';                       // the repeating timers are the news checks
  // the cron's UTC time today, as New York clock time
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.UTC(+uk.date.slice(0, 4), +uk.date.slice(5, 7) - 1, +uk.date.slice(8, 10), +cron[1], +cron[0]))).map(x => [x.type, x.value]));
  return Object.keys(SLOTS).find(k => SLOTS[k].ny === `${p.hour}:${p.minute}`) || null;
}

// free delayed prices (Yahoo). Optional: the report still works without them.
async function quote(sym) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT.feed) });
    const m = (await r.json()).chart.result[0].meta;
    if (!(m.regularMarketPrice > 0 && m.chartPreviousClose > 0)) return null;
    return { px: m.regularMarketPrice, chg: m.regularMarketPrice - m.chartPreviousClose, pct: 100 * (m.regularMarketPrice / m.chartPreviousClose - 1) };
  } catch { return null; }
}
// a stock's move outside regular hours: last pre/after-hours trade vs the regular close (after the close) or the previous close (before the open)
async function extendedMove(sym, pre) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=5m&includePrePost=true`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT.feed) });
    const res = (await r.json()).chart.result[0], m = res.meta, last = (res.indicators.quote[0].close || []).filter(v => v > 0).slice(-1)[0];
    const base = pre ? m.chartPreviousClose : m.regularMarketPrice;
    return last > 0 && base > 0 ? 100 * (last / base - 1) : null;
  } catch { return null; }
}
async function marketNumbers() {
  const [nq, tnx, dxy] = await Promise.all([quote('NQ=F'), quote('^TNX'), quote('DX-Y.NYB')]);
  return { nq, tnx, dxy };
}
// 2026-10-27: GOLD reports for the second server (mainly gold, short dollar / FX view): secret GOLD_WEBHOOK
async function goldNumbers() {
  const [gold, silver, tnx, dxy, eur, jpy, gbp] = await Promise.all([quote('GC=F'), quote('SI=F'), quote('^TNX'), quote('DX-Y.NYB'), quote('EURUSD=X'), quote('JPY=X'), quote('GBPUSD=X')]);
  return { gold, silver, tnx, dxy, eur, jpy, gbp };
}
function goldNumbersText(n) {
  const out = [];
  if (n.gold) out.push(`Gold futures ${n.gold.px.toFixed(1)} (${sgn(n.gold.chg, 1)} $, ${sgn(n.gold.pct, 2)}% since the last settlement)`);
  if (n.silver) out.push(`Silver ${n.silver.px.toFixed(2)} (${sgn(n.silver.pct, 2)}%)`);
  if (n.tnx) out.push(`US 10-year yield ${n.tnx.px.toFixed(3)}% (${sgn(n.tnx.chg * 100)} bp at the last US close)`);
  if (n.dxy) out.push(`Dollar index ${n.dxy.px.toFixed(2)} (${sgn(n.dxy.pct, 2)}%)`);
  if (n.eur) out.push(`EUR/USD ${n.eur.px.toFixed(4)} (${sgn(n.eur.pct, 2)}%)`);
  if (n.gbp) out.push(`GBP/USD ${n.gbp.px.toFixed(4)} (${sgn(n.gbp.pct, 2)}%)`);
  if (n.jpy) out.push(`USD/JPY ${n.jpy.px.toFixed(2)} (${sgn(n.jpy.pct, 2)}%)`);
  return out.join('\n') || 'not available';
}
const GOLD_FEEDS = [
  'https://www.fxstreet.com/rss/news',
  ...['gold price OR gold futures', 'Federal Reserve OR Powell OR rate cut', 'dollar OR forex OR yen OR euro', 'central bank gold OR gold ETF',
    'treasury yields OR inflation', 'Iran OR Israel OR Russia OR Ukraine OR tariffs'].map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1d&hl=en-US&gl=US&ceid=US:en`),
];
// free news headlines (RSS titles from the last day), so the report still has news when web search isn't available
async function headlines(feeds = FEEDS) {
  const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&apos;|&#39;|&#x2019;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const out = new Map();   // title -> age in hours (2026-10-23: the AI read yesterday's "Nasdaq ends sharply lower" as today's news, so each headline now carries its age)
  await Promise.all(feeds.map(async u => {
    try {
      const t = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT.feed) })).text();
      for (const m of [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10)) {
        const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1], date = (m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
        const age = date ? (Date.now() - Date.parse(date)) / 3600e3 : NaN;
        if (title && !(age >= 36)) { const k = unesc(title); if (!out.has(k) || age < out.get(k)) out.set(k, age); }
      }
    } catch { }
  }));
  return [...out].sort((a, b) => (isNaN(a[1]) ? 99 : a[1]) - (isNaN(b[1]) ? 99 : b[1])).slice(0, 40)
    .map(([h, age]) => `${isNaN(age) ? '[age unknown]' : age < 1 ? '[under 1 h ago]' : `[${Math.round(age)} h ago]`} ${h}`);
}
const JSON_H = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
const getJson = async u => (await fetch(u, { headers: JSON_H, signal: AbortSignal.timeout(TIMEOUT.feed) })).json();
const ukParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
// New York clock time "HH:MM" of a moment (default now) - everything shown to readers is in ET
const et = (d = new Date()) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value])); return `${p.hour}:${p.minute}`; };
const addDays = (ymd, k) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

// which US releases matter for NQ (Nasdaq's calendar has no importance rating)
const HIGH = /\b(CPI|PCE|Nonfarm Payrolls|Unemployment Rate|Retail Sales|GDP|Interest Rate Decision|Fed Funds|FOMC|ISM (Manufacturing|Non-Manufacturing|Services)|PPI)\b/i;
const MEDIUM = /\b(Jobless Claims|Michigan (Consumer Sentiment|1-Year Inflation|5-Year Inflation)|S&P Global (Manufacturing|Services|Composite) PMI|ADP (Nonfarm|Employment Change)$|JOLTS|Durable Goods|CB Consumer Confidence|Average Hourly Earnings|Powell|Beige Book|New Home Sales|Existing Home Sales|Philadelphia Fed|NY Empire|Industrial Production)\b/i;
const SKIP = /4-Week Avg|Continuing|CFTC|Baker Hughes|Mortgage|Natural Gas|Crude|Auction|Leading Index|Weekly/i;
const clean = s => String(s || '').replace(/&nbsp;/g, '').trim();
// New York wall time -> UK "HH:MM" (works across both clock changes)
function nyToUk(ymd, hhmm) {
  const [y, mo, d] = ymd.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  let t = Date.UTC(y, mo - 1, d, h + 5, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  t -= ((+p.hour * 60 + +p.minute) - (h * 60 + mi)) * 60e3;
  const u = ukParts(new Date(t)); return `${u.hour}:${u.minute}`;
}
// today's US calendar with forecasts and (once out) actual numbers, UK time. Nasdaq's date parameter returns the previous day, so ask for tomorrow.
// foreign=true (gold reports): also the high-impact releases of the euro zone, UK, Japan, China, Germany, Switzerland (shown as "Country: event")
const FOREIGN = /^(Euro Zone|United Kingdom|Japan|China|Germany|Switzerland)$/;
async function calendar(ukDate, foreign = false) {
  try {
    return ((await getJson('https://api.nasdaq.com/api/calendar/economicevents?date=' + addDays(ukDate, 1))).data?.rows || [])
      .filter(x => !SKIP.test(x.eventName) && ((x.country === 'United States' && (HIGH.test(x.eventName) || MEDIUM.test(x.eventName))) || (foreign && FOREIGN.test(x.country) && HIGH.test(x.eventName))))
      .map(x => ({ time: nyToUk(ukDate, x.gmt), et: x.gmt, impact: HIGH.test(x.eventName) ? 'High' : 'Medium', title: (x.country === 'United States' ? '' : x.country + ': ') + x.eventName, us: x.country === 'United States', forecast: clean(x.consensus), previous: clean(x.previous), actual: clean(x.actual) }))
      .sort((a, b) => a.time.localeCompare(b.time));
  } catch { return null; }
}
// earnings of the biggest Nasdaq-100 companies (Nasdaq earnings calendar)
const BIG = new Set(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'AVGO', 'TSLA', 'NFLX', 'COST', 'AMD', 'PLTR', 'ASML', 'CSCO', 'TMUS', 'ADBE', 'QCOM', 'INTU', 'AMAT', 'TXN', 'ISRG', 'BKNG', 'PEP', 'LIN', 'MU', 'LRCX', 'ARM']);
async function earnings(dates) {
  const out = [];
  await Promise.all(dates.map(async d => {
    try {
      for (const x of (await getJson('https://api.nasdaq.com/api/calendar/earnings?date=' + d)).data?.rows || [])
        // after a company reports, Nasdaq often changes its time to "not supplied" - treat that as a possible after-close report
        if (BIG.has(x.symbol)) out.push({ date: d, symbol: x.symbol, name: x.name, pre: /pre/.test(x.time),
          when: /after/.test(x.time) ? 'after the close (~16:05 ET)' : /pre/.test(x.time) ? 'before the open (~07:00-08:00 ET)' : 'time not given',
          eps: clean(x.epsForecast), actual: /\d/.test(x.eps || '') ? clean(x.eps) : '', surprise: /\d/.test(x.surprise || '') ? clean(x.surprise) : '' });
    } catch { }
  }));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
const sgn = (v, d = 0) => (v > 0 ? '+' : '') + v.toFixed(d);
function numbersText(n) {
  const out = [];
  if (n.nq) out.push(`NQ ${n.nq.px.toFixed(2)} (${sgn(n.nq.chg)} pts since the last settlement)`);
  if (n.tnx) out.push(`US 10-year yield ${n.tnx.px.toFixed(3)}% (${sgn(n.tnx.chg * 100)} bp at the last US close)`);
  if (n.dxy) out.push(`Dollar index ${n.dxy.px.toFixed(2)} (${sgn(n.dxy.pct, 2)}%)`);
  return out.join('\n') || 'not available';
}

function slotTask(slot, d) {
  const u = t => t + ' ET';
  switch (slot) {
    case 'morning': return 'MORNING BRIEF before London. Cover overnight news, today\'s US calendar (ET times, with forecasts) and the big NQ earnings this week.';
    case 'midday': return 'MIDDAY UPDATE. What changed since the morning; the next release and what result would flip the bias.';
    case 'post1': return `DATA RESULT. If NO high-impact US release came out between ${u('07:25')} and ${u('08:35')} today, return {"skip": true}. Otherwise report actual vs forecast, the immediate reaction in yields/NQ, and whether the bias changes.`;
    case 'post2': return `DATA RESULT. If NO high-impact or medium-impact US release came out between ${u('09:40')} and ${u('10:05')} today, return {"skip": true}. Otherwise report actual vs forecast, the reaction, and whether the bias changes.`;
    case 'earnings': return 'EARNINGS RESULT for the big Nasdaq-100 companies that reported after the US close today (listed below with EPS vs expected and the after-hours move). If the headlines and data show none of them has actually reported yet, return {"skip": true}. Otherwise for each: revenue and guidance vs expected if the headlines say, why the stock is moving, what it means for NQ, and the NQ bias for tomorrow. Put the key facts in "result".';
    case 'preny': return `BEFORE THE NY OPEN (${u('09:30')}). Bias for the cash session, what to watch in the first hours, the next release. If big companies reported before the open (listed below), explain their results and pre-market moves in "result".`;
  }
}

// tries each model with Google web search first, then each model without it (the free tier may not allow search)
// 2026-10-27: the free tier allows only 20 requests a DAY on gemini-3.8-flash and 3.6-flash. The news desks (~64 checks a day x 3 desks)
// were using them up, so the news desks start with the small model and the two big ones are kept for the NQ / gold reports (~10 a day).
const NEWS_MODELS = (process.env.NEWS_MODEL || 'gemini-3.5-flash-lite,gemini-3.6-flash').split(',');
const exhausted = new Set();   // models that hit their DAILY limit in this run - not asked again
async function callGemini(system, user, trySearch = true, models = MODELS) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  let lastErr;
  // 503 / 500 / 429 = Google busy for a moment: after every model failed, wait 20 s and go round once more (no web search)
  const rounds = trySearch ? [true, false, 'retry'] : [false, 'retry'];
  for (const round of rounds) for (const model of models) {
    if (exhausted.has(model)) continue;
    if (round === 'retry') { if (!/: (5\d\d|429)\b/.test(lastErr?.message || '')) break; if (model === models.find(m => !exhausted.has(m))) { console.log('all models busy - waiting 20 s and trying again'); await new Promise(r => setTimeout(r, 20000)); } }
    const search = round === true;
    const tag = `${model}${search ? ' + web search' : ' (no web search)'}`;
    try {
      const body = { systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature: 0.3 },
        contents: [{ role: 'user', parts: [{ text: search ? user : user + '\n\nWeb search is not available this time: work from the headlines above only, and leave out forecasts and calendar items you cannot see.' }] }] };
      if (search) body.tools = [{ google_search: {} }];
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT.ai) });
      const j = await r.json();
      if (!r.ok) {
        lastErr = new Error(`${tag}: ${r.status}`);
        const daily = r.status === 429 && /PerDay|per day/i.test(JSON.stringify(j.error || j));
        if (daily) exhausted.add(model);
        console.log(daily ? `${tag}: 429 daily free limit reached - not used again in this run` : `${tag}: ${r.status} ${JSON.stringify(j.error || j).slice(0, 1500)}`);
        continue;
      }
      const text = (j.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('\n');
      if (text.trim()) { console.log('model used: ' + tag); status.model = tag; return text; }
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

const dayName = ymd => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
function calendarLines(evts) { return evts.map(e => `${e.et} ${e.impact === 'High' ? '🔴' : '🟠'} ${e.title}${e.actual ? ` · actual **${e.actual}**` : ''}${e.forecast ? ` · forecast ${e.forecast}` : ''}${e.previous ? ` · previous ${e.previous}` : ''}`); }
const nextWeek = (d, today) => (Date.parse(d) - Date.parse(today)) / 864e5 >= 3 && new Date(today + 'T12:00:00Z').getUTCDay() >= 4;
const shortName = n => n.replace(/,?\s+(Incorporated|Corporation|Inc\.?|Corp\.?|plc|N\.V\.|Holdings?)(?=[\s,.]|$)|\s+\(The\)/gi, '').replace(/[,\s]+$/, '').trim();
function earningsLines(list, today) { return list.map(e => `${e.date === today ? '**Today**' : (nextWeek(e.date, today) ? 'Next ' : '') + dayName(e.date)} · **${shortName(e.name)}** (${e.symbol}) · ${e.when}${e.eps ? ` · EPS forecast ${e.eps}` : ''}`); }
// results lines: actual vs forecast EPS + the share's move outside regular hours
function resultLines(list, pre) {
  return list.map(e => `**${shortName(e.name)}** (${e.symbol})` +
    (e.actual ? ` · EPS **${e.actual}** vs ${e.eps || '?'} expected${e.surprise ? ` (${+e.surprise > 0 ? 'beat' : 'miss'} ${Math.abs(+e.surprise)}%)` : ''}` : ' · results not in the data yet') +
    (e.move != null ? ` · ${pre ? 'pre-market' : 'after hours'} ${e.move > 0 ? '+' : ''}${e.move.toFixed(1)}% ${e.move > 0 ? '🟢' : '🔴'}` : ''));
}

function buildEmbed(slot, r, n, extra = {}) {
  const bias = (r.bias || 'NEUTRAL').toUpperCase(), conf = (r.confidence || '').toUpperCase();
  const parts = [];
  const nums = [];
  if (n.nq) nums.push(`**NQ** ${sgn(n.nq.chg)} pts`);
  if (n.tnx) nums.push(`**10y** ${n.tnx.px.toFixed(2)}% (${sgn(n.tnx.chg * 100)} bp)`);
  if (n.dxy) nums.push(`**DXY** ${n.dxy.px.toFixed(2)} (${sgn(n.dxy.pct, 2)}%)`);
  // bias on its own underlined line (Discord titles can't be underlined); the numbers sit right under it
  parts.push(`__**NQ bias ${bias}${conf ? ' · confidence ' + conf : ''}**__` + (nums.length && slot !== 'earnings' ? '\n' + nums.join(' · ') : ''));
  if (r.result?.length) parts.push('**RESULT**\n' + r.result.map(x => '• ' + x).join('\n'));
  if (r.scenarios?.length && extra.prevTitle) parts.push(`**🎯 CHECKING THE ${extra.prevTitle.toUpperCase()} SCENARIOS**\n` + r.scenarios.join('\n'));
  if (r.why?.length) parts.push('**WHY**\n' + r.why.map(x => '• ' + x).join('\n'));
  if (extra.calendar) parts.push(`**${extra.calendarTitle}**\n` + (extra.calendar.length ? calendarLines(extra.calendar).join('\n') : 'No medium or high impact US data.'));
  if (extra.earnings?.length) parts.push('**📅 EARNINGS (big NQ companies)**\n' + earningsLines(extra.earnings, extra.today).join('\n'));
  if (extra.results?.length) parts.push(`**📢 ${extra.resultsTitle}**\n` + resultLines(extra.results, extra.resultsPre).join('\n'));
  if (r.watch?.length) parts.push('**WATCH**\n' + r.watch.map(x => '• ' + x).join('\n'));
  if (r.change?.length) parts.push('**WHAT WOULD CHANGE IT**\n' + r.change.map(x => '• ' + x).join('\n'));
  if (r.headlines?.length) parts.push('**HEADLINES**\n' + r.headlines.slice(0, 3).map(x => '• ' + x).join('\n'));
  return {
    title: cut(`${SLOTS[slot].title}${r.headline ? ': ' + r.headline : ''}`, 256),
    description: cut(parts.join('\n\n​\n'), 4000),   // blank line + invisible line = a wider gap between sections (Discord drops plain extra blank lines)
    color: COLOR[bias] ?? COLOR.NEUTRAL,
    footer: { text: `${DISCLAIMER} · next report ${SLOTS[slot].next(extra.today)} · calendar & earnings: Nasdaq` },
    timestamp: new Date().toISOString(),
  };
}

// gold report: gold bias on top, the dollar's direction and a short line per currency pair under it
const GOLD_TITLES = { morning: '🥇 GOLD MORNING BRIEF', midday: '🥇 GOLD BEFORE NEW YORK', post1: '⚡ GOLD · DATA RESULT', post2: '⚡ GOLD · DATA RESULT' };
const GOLD_NEXT = { morning: '08:00 ET', midday: 'after any 08:30 ET data, or 02:00 ET', post1: 'after any 10:00 ET data, or 02:00 ET', post2: '02:00 ET' };
function goldNums(n) {
  const nums = [];
  if (n.gold) nums.push(`**Gold** ${n.gold.px.toFixed(1)} (${sgn(n.gold.pct, 2)}%)`);
  if (n.silver) nums.push(`**Silver** ${sgn(n.silver.pct, 2)}%`);
  if (n.tnx) nums.push(`**10y** ${n.tnx.px.toFixed(2)}% (${sgn(n.tnx.chg * 100)} bp)`);
  if (n.dxy) nums.push(`**DXY** ${n.dxy.px.toFixed(2)} (${sgn(n.dxy.pct, 2)}%)`);
  return nums;
}
function buildGoldEmbed(slot, r, n, extra = {}) {
  const bias = (r.bias || 'NEUTRAL').toUpperCase(), conf = (r.confidence || '').toUpperCase(), usd = (r.usd || '').toUpperCase();
  const parts = [], nums = goldNums(n);
  parts.push(`__**GOLD bias ${bias}${conf ? ' · confidence ' + conf : ''}**__` + (nums.length ? '\n' + nums.join(' · ') : ''));
  if (r.result?.length) parts.push('**RESULT**\n' + r.result.map(x => '• ' + x).join('\n'));
  if (r.scenarios?.length && extra.prevTitle) parts.push(`**🎯 CHECKING THE ${extra.prevTitle.toUpperCase()} SCENARIOS**\n` + r.scenarios.join('\n'));
  if (r.why?.length) parts.push('**WHY**\n' + r.why.map(x => '• ' + x).join('\n'));
  if (usd || r.fx?.length) parts.push(`**💵 DOLLAR${usd ? ' ' + usd : ''}**` + (r.fx?.length ? '\n' + r.fx.map(x => '• ' + x).join('\n') : ''));
  if (extra.calendar) parts.push(`**${extra.calendarTitle}**\n` + (extra.calendar.length ? calendarLines(extra.calendar).join('\n') : 'No medium or high impact data.'));
  if (r.watch?.length) parts.push('**WATCH**\n' + r.watch.map(x => '• ' + x).join('\n'));
  if (r.change?.length) parts.push('**WHAT WOULD CHANGE IT**\n' + r.change.map(x => '• ' + x).join('\n'));
  if (r.headlines?.length) parts.push('**HEADLINES**\n' + r.headlines.slice(0, 3).map(x => '• ' + x).join('\n'));
  return {
    title: cut(`${GOLD_TITLES[slot]}${r.headline ? ': ' + r.headline : ''}`, 256),
    description: cut(parts.join('\n\n​\n'), 4000),
    color: COLOR[bias] ?? COLOR.NEUTRAL,
    footer: { text: `${DISCLAIMER} · next report ${GOLD_NEXT[slot]} · calendar: Nasdaq` },
    timestamp: new Date().toISOString(),
  };
}
function backupGoldEmbed(slot, n) {
  let score = 0, used = 0;
  if (n.gold) { score += Math.sign(n.gold.chg); used++; }
  if (n.tnx) { score -= Math.sign(n.tnx.chg); used++; }
  if (n.dxy) { score -= Math.sign(n.dxy.chg); used++; }
  const bias = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';
  return {
    title: `${GOLD_TITLES[slot]} (basic)`,
    description: `__**GOLD bias ${bias}**__\n` + goldNumbersText(n) + `\n\nRule: gold up, yield down and dollar down each count bullish (opposite = bearish). Score ${sgn(score)} of ${used}.\nThe full AI report was not available this time.`,
    color: COLOR[bias], footer: { text: `${DISCLAIMER} · next report ${GOLD_NEXT[slot]}` }, timestamp: new Date().toISOString(),
  };
}

// backup: numbers + fixed rule, no AI (only for the scheduled briefs, not for result reports)
function backupEmbed(slot, n, d) {
  let score = 0, used = 0;
  if (n.nq) { score += Math.sign(n.nq.chg); used++; }
  if (n.tnx) { score -= Math.sign(n.tnx.chg); used++; }
  if (n.dxy) { score -= Math.sign(n.dxy.chg); used++; }
  const bias = score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';
  return {
    title: `${SLOTS[slot].title} (basic)`,
    description: `__**NQ bias ${bias}**__\n` + numbersText(n) + `\n\nRule: NQ up, yield down and dollar down each count bullish (opposite = bearish). Score ${sgn(score)} of ${used}.\nThe full AI report was not available this time.`,
    color: COLOR[bias], footer: { text: `${DISCLAIMER} · next report ${SLOTS[slot].next(d)}` }, timestamp: new Date().toISOString(),
  };
}

// 2026-10-25: every channel can be mirrored to a second channel (e.g. another server): secret <NAME>_2 next to <NAME>
const hooks = name => [process.env[name], process.env[name + '_2']].filter(Boolean);
async function post(embed, webhook = hooks('DISCORD_WEBHOOK'), username = 'FUNDAMENTALS') {
  const body = { username, embeds: [embed] };
  if (process.env.DRY === '1') { console.log(JSON.stringify(body, null, 2)); return; }
  const list = [].concat(webhook).filter(Boolean);
  if (!list.length) throw new Error('webhook not set');
  for (let k = 0; k < list.length; k++) {
    try {
      const r = await fetch(list[k], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT.discord) });
      if (!r.ok) throw new Error(`Discord ${r.status} ${await r.text()}`);
    } catch (e) {
      if (k === 0) throw e;   // the main channel failing is handled by the caller as before
      console.log(`second channel failed: ${e.message}`);   // the mirror failing never stops the main post
      if (username !== 'BOT HEALTH') await alert(`⚠️ **${username}** ${et()} ET: posting to the second channel failed (${cut(e.message, 200)}).`);
    }
  }
  console.log(username === 'FUNDAMENTALS' ? `posted to Discord (${list.length} channel${list.length > 1 ? 's' : ''})` : username === 'GOLD FUNDAMENTALS' ? 'gold report posted to Discord' : username === 'BOT HEALTH' ? 'health message sent' : `${username}: sent to ${list.length} channel${list.length > 1 ? 's' : ''}`);
}

// ---- breaking news: every 15 min (weekdays 07-22 UK, weekends every 2 h) -> #breaking-news (secret NEWS_WEBHOOK) ----
// Reads fresh headlines, skips ones already seen (news_state.json, kept between runs by the workflow cache),
// lets the AI score market impact 1-10 and posts stories scoring NEWS_MIN or more.
const NEWS_MIN = 6;
const NEWS_FEEDS = [
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',   // CNBC top news
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362',   // CNBC world
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',    // CNBC economy
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5ENDX,NQ%3DF,CL%3DF&region=US&lang=en-US',
  ...['stock market futures', 'tariffs OR sanctions OR trade war', 'Iran OR Israel OR Russia OR Ukraine OR Taiwan OR missile OR attack',
    'Federal Reserve OR Powell OR rate cut', 'oil prices OR OPEC', 'Nvidia OR Apple OR Microsoft OR Tesla OR Amazon OR Meta OR Alphabet',
    'breaking news White House OR Trump announces'].map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:2h&hl=en-US&gl=US&ceid=US:en`),
];
// only established outlets (Google News also returns blogs and small local sites)
const TRUSTED = /^(Reuters|Bloomberg|CNBC|The Wall Street Journal|WSJ|Financial Times|FT|Associated Press|AP News|AFP|Yahoo Finance|MarketWatch|Barron's|Axios|Politico|BBC|CNN|The New York Times|The Washington Post|The Guardian|Al Jazeera|Nikkei Asia|South China Morning Post|Fox Business|Investing\.com|FXStreet|Kitco|Business Insider|Fortune|The Hill|NBC News|ABC News|CBS News|The Times of Israel|Semafor|Forbes|The Economist|Bloomberg\.com|Reuters\.com|Seeking Alpha|TheStreet|Benzinga|Investopedia|ForexLive|Bloomberg Law|The Telegraph|Sky News|Kyiv Independent|Haaretz)\b/i;
// ---- crypto news desk -> #crypto-news (secret CRYPTO_WEBHOOK), same checks, own feeds / scale / memory ----
const CRYPTO_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/', 'https://cointelegraph.com/rss', 'https://www.theblock.co/rss.xml', 'https://decrypt.co/feed',
  ...['bitcoin OR BTC', 'ethereum OR ether', 'crypto SEC OR CFTC OR regulation OR stablecoin', 'crypto ETF inflows OR outflows',
    'crypto hack OR exploit OR liquidations', 'Binance OR Coinbase OR Tether OR MicroStrategy OR Strategy bitcoin'].map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:2h&hl=en-US&gl=US&ceid=US:en`),
];
const CRYPTO_TRUSTED = /^(CoinDesk|Cointelegraph|The Block|Decrypt|Blockworks|DL News|The Defiant|Bitcoin Magazine|CryptoSlate|Unchained|Reuters|Bloomberg|CNBC|Yahoo Finance|The Wall Street Journal|WSJ|Financial Times|Fortune|Forbes|Barron's|Axios|Business Insider|MarketWatch|Associated Press|AP News|Investing\.com|Benzinga|Bloomberg\.com|Reuters\.com|Coinbase|Kitco)\b/i;
const CRYPTO_STATE = path.join(__dirname, 'crypto_state.json');
// ---- gold news desk -> second server's gold news channel (secret GOLD_NEWS_WEBHOOK), mainly gold, also dollar / FX ----
const GOLD_NEWS_FEEDS = [
  'https://www.fxstreet.com/rss/news',
  ...['gold price OR gold futures OR XAU', 'Federal Reserve OR Powell OR rate cut', 'dollar index OR forex OR yen OR euro OR sterling',
    'central bank gold OR gold ETF OR PBOC gold', 'ECB OR "Bank of England" OR "Bank of Japan"', 'Iran OR Israel OR Russia OR Ukraine OR missile OR attack', 'tariffs OR sanctions OR trade war']
    .map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:2h&hl=en-US&gl=US&ceid=US:en`),
];
const GOLD_STATE = path.join(__dirname, 'gold_state.json');
const GOLD_REPORT_STATE = path.join(__dirname, 'gold_report_state.json');
const STATE_FILE = path.join(__dirname, 'news_state.json');
const REPORT_STATE = path.join(__dirname, 'report_state.json');   // last report's bias + "what would change it", checked by the next report
const hash = s => { let h = 0; for (const c of s.toLowerCase().replace(/[^a-z0-9]/g, '')) h = (h * 31 + c.charCodeAt(0)) | 0; return h.toString(36); };
async function newsItems(feeds, trusted) {
  const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&apos;|&#39;|&#x2019;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const out = new Map();
  await Promise.all(feeds.map(async u => {
    try {
      const t = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT.feed) })).text();
      for (const m of t.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const g = k => unesc((m[1].match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)<\\/${k}>`)) || [])[1] || '');
        const title = g('title'), when = Date.parse(g('pubDate'));
        if (!title || !(when > 0)) continue;
        const src = g('source') || [['cnbc', 'CNBC'], ['yahoo', 'Yahoo Finance'], ['coindesk', 'CoinDesk'], ['cointelegraph', 'Cointelegraph'], ['theblock', 'The Block'], ['decrypt', 'Decrypt'], ['fxstreet', 'FXStreet']].find(([k]) => u.includes(k))?.[1] || '';
        if (!trusted.test(src)) continue;
        const clean = title.replace(/\s+-\s+[^-]{2,40}$/, '');           // Google News adds " - Source" to titles
        out.set(hash(clean), { id: hash(clean), title: clean, src, link: g('link'), when });
      }
    } catch { }
  }));
  return [...out.values()];
}
// the two news desks: what to read, how to score it, where to post
const DESKS = {
  news: {
    label: 'news', feeds: NEWS_FEEDS, trusted: TRUSTED, state: STATE_FILE, webhook: 'NEWS_WEBHOOK', username: 'BREAKING NEWS', tag6: '📰 MARKET NEWS',
    dir: { RISK_ON: 'Risk-ON for NQ', RISK_OFF: 'Risk-OFF for NQ' },
    system: `You are a markets news editor for NQ (Nasdaq-100 futures) day traders. You score headlines for how much they can move US stock index futures, oil, gold, the dollar and yields.
Impact scale (be strict and consistent):
10 = market-shaking: war between major powers, emergency Fed move, major bank collapse.
9 = major shock: big military escalation hitting oil supply, sudden large tariffs on China/EU, Fed chair resigns.
8 = clearly moves NQ: new tariffs or sanctions enacted, ceasefire/peace deal, surprise Fed comments, ban hitting Nvidia/Apple-size company, government shutdown.
7 = notable: tariff threats, hawkish/dovish Fed speakers, OPEC decisions, China stimulus, big tech antitrust ruling, trade-talk headlines.
6 = relevant but small or brief: second-tier data surprises, regional Fed speakers, big non-mega-cap company news, diplomatic talks/warnings, 2-3% oil moves, sharp moves in Asian markets.
5 or less = normal news flow: ignore.
Partial or targeted measures (tariffs removed on SOME goods, one sector, a small partner, done for local politics) score 1-2 lower than the full version, and the headline keeps the limiting word ("some", "certain", "farm goods").
Follow-ups to a story already posted (same conflict, same oil spike, same tariff fight): post only a genuinely NEW development (a new attack, a new country involved, a new record level) and score it at most 7. Prices mentioned in headlines may be hours old - prefer the newest headline's number and never call an old level the current one.
Skip a story when a story already posted (listed) is about the same subject and newer or opposite (e.g. "stocks recover on diplomacy hopes" after "Trump threatens new strike" was posted) - the market has moved on.
Rules: group headlines about the same event into one story. Skip stories already posted (listed). Skip opinion pieces, "what to watch" previews, explainers and market wrap-ups that only describe moves. Never invent facts beyond the headlines. Plain simple English, bullets under 20 words. Never say buy/sell.
Answer with ONE JSON object only: {"stories":[{"ids":["headline ids"],"score":6-10,"headline":"short clear headline","direction":"RISK_ON"|"RISK_OFF"|"UNCLEAR","why":["1-2 bullets: why it matters for NQ"],"moves":{"NQ":"up|down|flat","Oil":"up|down|flat","Gold":"up|down|flat","Dollar":"up|down|flat","Yields":"up|down|flat"}}]} - only stories scoring ${NEWS_MIN} or more; {"stories":[]} if none.`,
  },
  crypto: {
    label: 'crypto', feeds: CRYPTO_FEEDS, trusted: CRYPTO_TRUSTED, state: CRYPTO_STATE, webhook: 'CRYPTO_WEBHOOK', username: 'CRYPTO NEWS', tag6: '🪙 CRYPTO NEWS',
    dir: { RISK_ON: 'Bullish for crypto', RISK_OFF: 'Bearish for crypto' },
    system: `You are a crypto news editor for Bitcoin and Ethereum traders. You score headlines for how much they can move BTC, ETH and the wider crypto market.
Impact scale (be strict and consistent):
10 = market-shaking: a top exchange or stablecoin collapses, Bitcoin ETFs banned/forced to close, a G7 country adopts or bans Bitcoin.
9 = major shock: hack/exploit over $500m, SEC/DOJ action against Binance/Coinbase/Tether-size firm, major stablecoin loses its peg, $2bn+ liquidations.
8 = clearly moves BTC/ETH: new ETF approval or rejection, record ETF inflows/outflows, major law or regulation passed, big government/treasury buying or selling, surprise Fed move hitting crypto.
7 = notable: large ETF flows, a big company buying BTC, exploit $50-500m, important court ruling, big exchange listing/delisting, major network upgrade dates.
6 = relevant but small or brief: smaller exploits, regulator comments, big altcoin news (SOL/XRP etc.), notable whale moves, sharp sector moves.
5 or less = normal news flow, price commentary, sponsored or promotional pieces: ignore.
Rules: group headlines about the same event into one story. Skip stories already posted (listed). Skip opinion pieces, price predictions, "what to watch" previews, explainers and market wrap-ups that only describe moves. Never invent facts beyond the headlines. Plain simple English, bullets under 20 words. Never say buy/sell.
Answer with ONE JSON object only: {"stories":[{"ids":["headline ids"],"score":6-10,"headline":"short clear headline","direction":"RISK_ON"|"RISK_OFF"|"UNCLEAR","why":["1-2 bullets: why it matters for crypto"],"moves":{"BTC":"up|down|flat","ETH":"up|down|flat","Alts":"up|down|flat"}}]} (RISK_ON = bullish for crypto, RISK_OFF = bearish) - only stories scoring ${NEWS_MIN} or more; {"stories":[]} if none.`,
  },
  gold: {
    label: 'gold news', feeds: GOLD_NEWS_FEEDS, trusted: TRUSTED, state: GOLD_STATE, webhook: 'GOLD_NEWS_WEBHOOK', username: 'GOLD NEWS', tag6: '🥇 GOLD NEWS',
    dir: { RISK_ON: 'Bullish for gold', RISK_OFF: 'Bearish for gold' },
    system: `You are a news editor for gold (XAU/USD, COMEX gold futures) traders who also watch the dollar and the main currency pairs. You score headlines for how much they can move GOLD first, then the dollar / FX.
What moves gold: US real yields and the 10-year yield (falling = gold up), the dollar (weaker = gold up), Fed rate expectations (cuts / dovish = gold up), safe-haven demand (war, geopolitical escalation, tariff shocks, stock market stress = gold up; de-escalation = gold down), central bank gold buying and gold ETF flows, China / India demand.
Impact scale (be strict and consistent):
10 = market-shaking: war between major powers, emergency Fed move, US debt default scare, a major central bank dumping gold.
9 = major shock: big military escalation (Middle East, Russia/NATO, Taiwan), surprise Fed decision, very large tariffs, a G7 currency in crisis.
8 = clearly moves gold: Fed chair clearly dovish/hawkish shift, big CPI/NFP surprise headline, ceasefire or peace deal, record central bank buying (e.g. PBOC), gold at a record high, Japan intervening in the yen.
7 = notable: Fed speakers, ECB/BoE/BoJ decisions or surprises, notable geopolitical news, large gold ETF flows, big tariff threats.
6 = relevant but small or brief: second-tier data, regional Fed speakers, smaller geopolitical warnings, 1-2% moves in gold or the dollar with a clear reason.
5 or less = normal news flow, technical price forecasts and chart levels ("Price Forecast", "Technical Analysis"), daily wrap-ups: ignore.
Follow-ups to a story already posted: only a genuinely new development, at most 7. Prices in headlines may be hours old - never call an old level the current one. Skip a story when a newer or opposite story on the same subject was already posted.
Rules: group headlines about the same event into one story. Skip stories already posted (listed). Skip opinion pieces, previews and explainers. Never invent facts beyond the headlines. Plain simple English, bullets under 20 words. Never say buy/sell.
Answer with ONE JSON object only: {"stories":[{"ids":["headline ids"],"score":6-10,"headline":"short clear headline","direction":"RISK_ON"|"RISK_OFF"|"UNCLEAR","why":["1-2 bullets: why it matters for gold (and the dollar if relevant)"],"moves":{"Gold":"up|down|flat","Dollar":"up|down|flat","EUR/USD":"up|down|flat","USD/JPY":"up|down|flat"}}]} (RISK_ON = bullish for gold, RISK_OFF = bearish for gold) - only stories scoring ${NEWS_MIN} or more; {"stories":[]} if none.`,
  },
};
async function newsCheck(uk) {
  console.log('news check started');
  const day = new Date(uk.date + 'T12:00:00Z').getUTCDay(), hr = +uk.time.slice(0, 2);
  const nyHr = +new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (day >= 1 && day <= 5 && (nyHr < 2 || nyHr >= 18)) { console.log(`news: outside 02:00-18:00 New York time (UK ${hr}h)`); return; }
  for (const desk of Object.values(DESKS)) {
    if (!hooks(desk.webhook).length && process.env.DRY !== '1') { console.log(`${desk.label}: no ${desk.webhook} secret - skipped`); continue; }
    await newsDesk(uk, desk);
  }
  // altcoin radar every 4 h: the first news check of 04/08/12/16 ET on weekdays, plus 00/20 ET at weekends (crypto never closes)
  const nyMin = +new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', minute: '2-digit' }).format(new Date());
  if (nyHr % 4 === 0 && nyMin < 15) await altRadar();
}

// ---- ALTCOIN RADAR (2026-10-27): which coins outside the blue chips are making headlines -> #altcoin-radar (secret ALTCOIN_WEBHOOK, mirror ALTCOIN_WEBHOOK_2) ----
// No AI: crypto headlines of the last 4 h, matched against CoinGecko's top 500 coins (name, or ticker in CAPITALS / with $), the same story on
// several sites counted once, price-prediction / promo pieces dropped, ranked by stories (trusted outlets count double). Plus CoinGecko trending.
const RADAR_HOURS = 4;
const BLUE_CHIPS = new Set(['btc', 'eth', 'bnb', 'sol', 'xrp', 'usdt', 'usdc', 'dai', 'usde', 'fdusd', 'tusd', 'pyusd', 'usds', 'usd1', 'wbtc', 'steth', 'weth', 'wsteth', 'weeth', 'cbbtc', 'reth', 'wbeth', 'bsc-usd', 'susde', 'buidl']);
const RADAR_FEEDS = [
  ...CRYPTO_FEEDS.filter(u => !u.includes('news.google.com')),
  ...['altcoin', 'token surges OR token plunges OR token rallies', 'memecoin OR meme coin', 'crypto hack OR exploit OR drained', 'token listing Binance OR Coinbase OR Upbit OR Robinhood',
    'crypto airdrop OR token unlock', 'altcoin ETF', 'crypto token partnership OR mainnet launch'].map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:${RADAR_HOURS}h&hl=en-US&gl=US&ceid=US:en`),
];
const RADAR_JUNK = /price prediction|price analysis|price forecast|technical analysis|could (rally|hit|reach|soar|explode)|will .* (hit|reach) \$|top \d+ (coins|altcoins|tokens)|best (crypto|altcoins?|coins?) to buy|presale|next 100x|1000x|sponsored|press release/i;
// coin names that are ordinary words / companies (only their ticker in CAPITALS counts, never the word)
const RADAR_COMMON = /^(the|ai|one|ton|link|uni|gas|key|act|ape|pump|sun|moon|core|safe|beam|blur|flow|rose|mask|bone|super|magic|ark|hot|win|any|me|my|ok|pol|s|w|io|ip|vet|bat|cat|dog|pepe|strategy|story|sonic|render|maker|celestia|kaia|degen|zora|virtual|movement|polygon|cronos|quant|aster|plume|world|bitcoin|ethereum|usual|lido|sky|jupiter|ethena|morpho|aave|maple|pi|ondo|stacks|theta|helium|arweave|walrus|layerzero)$/i;
const RADAR_STATE_NOTE = 'Attention, not direction: coins often make headlines after the price has already moved';
async function altRadar() {
  if (!hooks('ALTCOIN_WEBHOOK').length && process.env.DRY !== '1') { console.log('altcoin radar: no ALTCOIN_WEBHOOK secret - skipped'); return; }
  console.log('altcoin radar started');
  const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&apos;|&#39;|&#x2019;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const heads = new Map();
  await Promise.all(RADAR_FEEDS.map(async u => {
    try {
      const t = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT.feed) })).text();
      for (const m of t.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const g = k => unesc((m[1].match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)<\\/${k}>`)) || [])[1] || '');
        const when = Date.parse(g('pubDate')); if (!(when > 0) || Date.now() - when > RADAR_HOURS * 3600e3) continue;
        const src = g('source') || [['coindesk', 'CoinDesk'], ['cointelegraph', 'Cointelegraph'], ['theblock', 'The Block'], ['decrypt', 'Decrypt']].find(([k]) => u.includes(k))?.[1] || '';
        const title = g('title').replace(/\s+-\s+[^-]{2,40}$/, '');
        if (!title || RADAR_JUNK.test(title) || /openPR|GlobeNewswire|PR Newswire|PRNewswire|Accesswire|EIN Presswire|Business Wire|Newsfile/i.test(src)) continue;   // press-release sites = paid promotion
        heads.set(title.toLowerCase(), { title, src: src.replace(/^www\./, ''), link: g('link'), when });
      }
    } catch { }
  }));
  const H = [...heads.values()];
  let coins = [], trending = [];
  try {
    for (const p of [1, 2]) coins.push(...await getJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&price_change_percentage=24h`));
    trending = ((await getJson('https://api.coingecko.com/api/v3/search/trending')).coins || []).map(c => ({ sym: c.item.symbol, ch: c.item.data?.price_change_percentage_24h?.usd }));
  } catch (e) { console.log('altcoin radar: CoinGecko failed - ' + e.message); }
  console.log(`altcoin radar: ${H.length} headlines, ${coins.length} coins, ${trending.length} trending`);
  if (!coins.length) { await alert(`⚠️ **altcoin radar** ${et()} ET: CoinGecko coin list not available - nothing posted.`); return; }
  // the same story on several sites = one story (titles sharing most of their words)
  const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  const same = (a, b) => { const A = words(a), B = words(b); let k = 0; for (const w of A) if (B.has(w)) k++; return k / Math.max(1, Math.min(A.size, B.size)) >= 0.6; };
  const res = [];
  for (const c of coins) {
    const sym = String(c.symbol).toLowerCase(); if (BLUE_CHIPS.has(sym) || /wrapped|bridged|staked|tokenized|xstock/i.test(c.name)) continue;
    const name = c.name.replace(/\s*\(.*\)/, '');
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = name.length >= 4 && !RADAR_COMMON.test(name) ? new RegExp(`\\b${esc(name)}\\b`, 'i') : null;
    const symRe = sym.length >= 3 && !/^(the|for|and|now|new|top|big|all|eth|usd|ceo|etf|sec|ftx|nft|ai)$/.test(sym) ? new RegExp(`(\\$${esc(sym)}\\b|\\b${esc(c.symbol.toUpperCase())}\\b)`) : null;
    const hits = H.filter(h => (nameRe && nameRe.test(h.title)) || (symRe && symRe.test(h.title))).sort((a, b) => b.when - a.when);
    if (!hits.length) continue;
    const stories = [];
    for (const h of hits) { const s = stories.find(x => same(x.title, h.title)); if (s) s.more.add(h.src); else stories.push({ ...h, more: new Set() }); }
    const trusted = stories.filter(s => CRYPTO_TRUSTED.test(s.src) || [...s.more].some(o => CRYPTO_TRUSTED.test(o))).length;
    res.push({ sym: c.symbol.toUpperCase(), name, stories, score: stories.length + trusted, ch: c.price_change_percentage_24h, rank: c.market_cap_rank,
      trend: trending.findIndex(t => String(t.sym).toLowerCase() === sym) + 1 });
  }
  res.sort((a, b) => b.score - a.score || b.stories.length - a.stories.length || a.rank - b.rank);
  const pct = v => v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  const ago = t => { const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const block = (r, i) => {
    const head = `**${i + 1}. ${r.sym}${r.name.toUpperCase() !== r.sym ? ' · ' + r.name : ''}** · ${r.stories.length} stor${r.stories.length > 1 ? 'ies' : 'y'}` +
      `${r.trend ? ` · 🔍 trending #${r.trend}` : ''}${r.ch != null ? ` · ${pct(r.ch)} 24h ${r.ch >= 0 ? '🟢' : '🔴'}` : ''} · rank #${r.rank}${r.rank > 200 ? ' · small cap ⚠️' : ''}`;
    const lines = r.stories.slice(0, 3).map(s => `• ${s.link ? `[${cut(s.title, 110)}](${s.link})` : cut(s.title, 110)} — ${s.src || '?'}${s.more.size ? ` (+${s.more.size} more outlet${s.more.size > 1 ? 's' : ''})` : ''} · ${ago(s.when)}`);
    if (r.stories.length > 3) lines.push(`• +${r.stories.length - 3} more`);
    return head + '\n' + lines.join('\n');
  };
  const GAP = '\n​\n​\n';   // user: "a little bit more" gap between coins - two invisible lines
  const tr = trending.filter(t => !BLUE_CHIPS.has(String(t.sym).toLowerCase())).slice(0, 7).map(t => `${String(t.sym).toUpperCase()}${t.ch != null ? ' ' + pct(t.ch) : ''}`).join(' · ');
  const tail = tr ? `${GAP}**🔍 MOST SEARCHED ON COINGECKO**\n${tr}` : '';
  let desc = '', shown = 0;
  for (let i = 0; i < Math.min(res.length, 8); i++) { const add = (shown ? GAP : '') + block(res[i], i); if ((desc + add + tail).length > 3900) break; desc += add; shown++; }
  if (!shown) desc = 'No altcoin made the headlines in the last 4 h.';
  await post({ title: `🔥 ALTCOINS IN THE NEWS · last ${RADAR_HOURS} h`, description: desc + tail, color: 0xf0b232,
    footer: { text: `${RADAR_STATE_NOTE} · ${DISCLAIMER}` }, timestamp: new Date().toISOString() }, hooks('ALTCOIN_WEBHOOK'), 'ALTCOIN RADAR');
  console.log(`altcoin radar posted: ${shown} coins`);
}
const weekendNY = () => ['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()));
async function newsDesk(uk, desk) {
  let st = { seen: {}, posted: [] };
  try { st = JSON.parse(fs.readFileSync(desk.state, 'utf8')); } catch { console.log(`${desk.label}: no saved state - first run`); }
  const now = Date.now(), firstRun = !Object.keys(st.seen).length;
  const allNew = (await newsItems(desk.feeds, desk.trusted)).filter(x => !st.seen[x.id] && now - x.when < (firstRun ? 45 : weekendNY() ? 135 : 75) * 60e3)   // weekend checks are 2 h apart - 135 min so nothing falls in the gap   // 2026-10-23: a 15:09 ET story reached the feed at 16:30 and was posted after a newer opposite one - older than 75 min = stale for traders.sort((a, b) => b.when - a.when);
  for (const x of allNew) st.seen[x.id] = x.when;                                   // everything fetched counts as seen
  const fresh = allNew.slice(0, 60);
  console.log(`${desk.label}: ${allNew.length} new headlines${allNew.length > 60 ? ' (newest 60 checked)' : ''}`);
  for (const k in st.seen) if (now - st.seen[k] > 2 * 864e5) delete st.seen[k];      // remember 2 days
  st.posted = (st.posted || []).filter(p => now - p.t < 864e5);
  if (fresh.length) {
    const user = `New York time now ${uk.weekday} ${uk.date} ${et()} ET.\n\nAlready posted in the last 24 h (do not repeat):\n${st.posted.map(p => `- ${et(new Date(p.t))} ET: ${p.h}`).join('\n') || 'none'}\n\nNew headlines:\n${fresh.map(x => `[${x.id}] ${et(new Date(x.when))} ET: ${x.title}${x.src ? ' (' + x.src + ')' : ''}`).join('\n')}`;
    let res;
    try { res = parseJson(await callGemini(desk.system, user, false, NEWS_MODELS)); }
    catch (e) { console.log(`${desk.label} AI failed: ` + e.message); await alert(`⚠️ **${desk.label}** ${et()} ET: the AI check failed (${cut(e.message, 200)}) - ${fresh.length} headlines not checked.`); for (const x of fresh) delete st.seen[x.id]; res = { stories: [] }; }
    const arrow = v => v === 'up' ? '🟢' : v === 'down' ? '🔴' : '⚪';
    for (const s of (res.stories || []).filter(s => s.score >= NEWS_MIN).sort((a, b) => b.score - a.score).slice(0, 2)) {   // 2026-10-23: 31 posts in a day was too many - at most 2 per check
      const src = fresh.filter(x => (s.ids || []).map(String).includes(x.id)).sort((a, b) => a.when - b.when)[0] || {};
      const tag = s.score >= 8 ? '🚨 BREAKING' : s.score >= 7 ? '⚠️ NEWS' : desk.tag6;
      const dir = desk.dir[s.direction] || 'Direction unclear';
      const t = src.when ? et(new Date(src.when)) : null;
      const moves = Object.entries(s.moves || {}).map(([k, v]) => `${k} ${arrow(v)}`).join(' · ');
      await post({
        title: cut(`${tag} · Impact ${s.score}/10`, 256), url: src.link || undefined,
        description: cut(`**${s.headline}**\n\n​\n__**${dir}**__\n${(s.why || []).map(x => '• ' + x).join('\n\n')}${moves ? `\n\n​\n**Likely moves:** ${moves}` : ''}`, 4000),   // ​ line = wider gap
        color: s.direction === 'RISK_OFF' ? COLOR.BEARISH : s.direction === 'RISK_ON' ? COLOR.BULLISH : COLOR.NEUTRAL,
        footer: { text: `${t ? t + ' ET · ' : ''}${DISCLAIMER}` }, timestamp: new Date().toISOString(),
      }, hooks(desk.webhook), desk.username);
      st.posted.push({ t: now, h: s.headline });
      console.log(`${desk.label} posted: ${s.score}/10 ${s.headline}`);
    }
  }
  fs.writeFileSync(desk.state, JSON.stringify(st));
}

// ---- watchdog: instant alerts + nightly summary to a private #bot-health channel (secret HEALTH_WEBHOOK; optional) ----
const status = { model: '', problems: [] };
async function alert(text, color = 0xf85149) {
  if (!process.env.HEALTH_WEBHOOK && process.env.DRY !== '1') return;
  try { await post({ description: cut(text, 4000), color, timestamp: new Date().toISOString() }, process.env.HEALTH_WEBHOOK, 'BOT HEALTH'); } catch (e) { console.log('health alert failed: ' + e.message); }
}
// reads today's GitHub runs (built-in GITHUB_TOKEN, read-only) and their logs, one line per report
async function healthCheck(uk) {
  const repo = process.env.GITHUB_REPOSITORY, gh = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'fundamentals-bot' };
  const api = async p => { const r = await fetch('https://api.github.com/repos/' + repo + p, { headers: gh, signal: AbortSignal.timeout(TIMEOUT.feed) }); if (!r.ok) throw new Error(`GitHub ${r.status} ${p}`); return r; };
  const runs = (await (await api(`/actions/runs?created=%3E%3D${uk.date}&per_page=100`)).json()).workflow_runs || [];
  const seen = {}, lines = [], news = { runs: 0, posted: 0, failed: 0, scores: [] }, crypto = { posted: 0, failed: 0, scores: [] }, goldNews = { posted: 0, failed: 0, scores: [] }, goldRep = [], radarPosts = [];
  for (const run of runs.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (run.id === +process.env.GITHUB_RUN_ID) continue;
    const jobs = (await (await api(`/actions/runs/${run.id}/jobs`)).json()).jobs || [];
    let log = ''; try { if (jobs[0]) log = await (await api(`/actions/jobs/${jobs[0].id}/logs`)).text(); } catch { }
    if (/news check started/.test(log)) {                                    // news checks: one summary line, not one per run
      news.runs++;
      if (run.conclusion !== 'success' || /(?<!gold )news AI failed/.test(log)) news.failed++;
      for (const m of log.matchAll(/(?<!gold )news posted: (\d+)\/10/g)) { news.posted++; news.scores.push(+m[1]); }
      for (const m of log.matchAll(/gold news posted: (\d+)\/10/g)) { goldNews.posted++; goldNews.scores.push(+m[1]); }
      for (const m of log.matchAll(/altcoin radar posted: (\d+) coins/g)) radarPosts.push(+m[1]);
      if (/gold news AI failed/.test(log)) goldNews.failed++;
      for (const m of log.matchAll(/crypto posted: (\d+)\/10/g)) { crypto.posted++; crypto.scores.push(+m[1]); }
      if (/crypto AI failed/.test(log)) crypto.failed++;
      continue;
    }
    if (/health check started/.test(log) || (run.status !== 'completed' && !log)) {  // other health checks, or a run still going
      if (run.status !== 'completed' && !/health check started/.test(log)) lines.push(`⏳ run #${run.run_number} still running`);
      continue;
    }
    const slot = (log.match(/(?<!gold )report: (\w+)/) || [])[1];
    const gslot = (log.match(/gold report: (\w+)/) || [])[1];   // the gold report made in the same run (second server)
    if (gslot) goldRep.push(`${gslot} ${/gold report posted/.test(log) ? (/gold AI failed/.test(log) ? '⚠️ basic' : '✅') : /gold AI failed/.test(log) ? '❌' : '⏭️'}`);
    if (!slot && /no report due/.test(log)) continue;                       // the other season's timer
    const at = et(new Date(run.updated_at)) + ' ET', late = Math.round((Date.parse(run.run_started_at) - Date.parse(run.created_at)) / 60e3);
    const manual = run.event === 'workflow_dispatch' && !/started by timer/.test(log) ? ' (manual test)' : '';
    const model = (log.match(/model used: ([^\r\n]+)/) || [])[1];
    let line;
    if (run.status !== 'completed') line = `⏳ **${slot || '?'}**${manual} ${at}: still running`;
    else if (run.conclusion !== 'success') line = `❌ **${slot || '?'}**${manual} ${at}: run ${run.conclusion}`;
    else if (/skipped/.test(log)) line = `⏭️ **${slot}**${manual} ${at}: skipped - ${(log.match(/(no [^\r\n]*?) - skipped|(nothing to report[^\r\n]*)/) || [])[1] || 'nothing to report'}`;
    else if (/AI report failed/.test(log)) line = `⚠️ **${slot}**${manual} ${at}: basic report only - ${cut((log.match(/AI report failed: ([^\r\n]+)/) || [])[1], 120)}`;
    else if (/posted to Discord/.test(log)) line = `✅ **${slot}**${manual} ${at}${model ? ' · ' + model.replace(' (no web search)', '') : ''}`;
    else line = `❓ **${slot || '?'}**${manual} ${at}: finished but nothing posted`;
    if (late >= 15) line += ` · started ${late} min late`;
    lines.push(line); if (slot && !manual) seen[slot] = true;
  }
  const nowMin = +uk.time.slice(0, 2) * 60 + +uk.time.slice(3, 5);
  const etMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const missing = REPORT_SLOTS.filter(s => !seen[s] && etMin(SLOTS[s].ny) + 30 < etMin(et()));
  for (const s of missing) lines.push(`❓ **${s}** (${SLOTS[s].ny} ET): no run found - GitHub didn't start it`);
  if (news.runs) lines.push(`${news.failed ? '⚠️' : '📰'} **news**: ${news.runs} checks, ${news.posted} posted${news.scores.length ? ' (scores ' + news.scores.join(', ') + ')' : ''}${news.failed ? `, ${news.failed} failed` : ''}`);
  if (news.runs) lines.push(`${crypto.failed ? '⚠️' : '🪙'} **crypto news**: ${crypto.posted} posted${crypto.scores.length ? ' (scores ' + crypto.scores.join(', ') + ')' : ''}${crypto.failed ? `, ${crypto.failed} checks failed` : ''}`);
  if (radarPosts.length) lines.push(`🔥 **altcoin radar**: ${radarPosts.length} posted (${radarPosts.join(', ')} coins)`);
  if (news.runs && process.env.GOLD_NEWS_WEBHOOK) lines.push(`${goldNews.failed ? '⚠️' : '🥇'} **gold news**: ${goldNews.posted} posted${goldNews.scores.length ? ' (scores ' + goldNews.scores.join(', ') + ')' : ''}${goldNews.failed ? `, ${goldNews.failed} checks failed` : ''}`);
  if (goldRep.length) lines.push(`🥇 **gold reports**: ${goldRep.join(' · ')}`);
  const bad = lines.filter(l => /^(❌|⚠️|❓)/.test(l) && !/manual test/.test(l)).length;
  if (runs.length >= 100) lines.push('(only the first 100 runs of the day were checked)');   // manual tests don't count as problems
  await alert(`**🩺 BOT HEALTH · ${uk.weekday} ${uk.date}** - ${bad ? bad + ' problem(s)' : 'all good'}\n\n${lines.join('\n') || 'no runs today'}`, bad ? 0xf85149 : 0x3fb950);
}

(async () => {
  const uk = ukNow();
  const slot = pickSlot(uk);
  if (slot === 'radar') { for (const f of [STATE_FILE, CRYPTO_STATE, GOLD_STATE, REPORT_STATE, GOLD_REPORT_STATE]) try { fs.unlinkSync(f); } catch { } status.slot = 'radar'; await altRadar(); return; }   // manual test of the altcoin radar
  if (!slot || (!SLOTS[slot] && slot !== 'news')) { console.log(`no report due (UK ${uk.time}, cron "${process.env.CRON || ''}") - other season's timer, exiting`); return; }
  if (slot === 'health') { for (const f of [STATE_FILE, CRYPTO_STATE, GOLD_STATE, REPORT_STATE, GOLD_REPORT_STATE]) try { fs.unlinkSync(f); } catch { } console.log('health check started'); await healthCheck(uk); return; }
  // each kind of run only saves its own state file (the other is deleted so the cache step skips it - avoids overwriting newer state)
  for (const f of slot === 'news' ? [REPORT_STATE, GOLD_REPORT_STATE] : [STATE_FILE, CRYPTO_STATE, GOLD_STATE]) try { fs.unlinkSync(f); } catch { }
  if (slot === 'news') { status.slot = 'news'; await newsCheck(uk); return; }
  status.slot = slot;
  // 2026-10-27: the same run also makes the GOLD report for the second server (morning, midday and the data results), after the NQ one
  let err = null;
  try { await nqReport(uk, slot); } catch (e) { err = e; }
  if (GOLD_TITLES[slot] && (process.env.GOLD_WEBHOOK || process.env.DRY === '1')) {
    try { await goldReport(uk, slot); }
    catch (e) { console.log('gold AI failed: ' + e.message); await alert(`⚠️ **gold ${slot}** ${et()} ET: the gold report failed (${cut(e.message, 300)}).`); }
  }
  if (err) throw err;
})().then(() => process.exit(0), async e => { console.error(e); await alert(`❌ **${status.slot || 'bot'}**: crashed - ${cut(e.message, 500)}`); process.exit(1); });

async function goldReport(uk, slot) {
  console.log(`gold report: ${slot}`);
  const [n, news, cal] = await Promise.all([goldNumbers(), headlines(GOLD_FEEDS), calendar(uk.date, true)]);
  const today = cal || [];
  console.log(`gold prices: ${n.gold ? 'gold ok' : 'gold missing'}, ${n.dxy ? 'DXY ok' : 'DXY missing'} · headlines: ${news.length} · calendar: ${cal ? today.length + ' events' : 'missing'}`);
  const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5), nowMin = toMin(uk.time);
  const extra = {};
  if (slot === 'post1' || slot === 'post2') {
    const w = t => toMin(nyToUk(uk.date, t));
    const [a, b] = slot === 'post1' ? [w('07:25'), w('08:35')] : [w('09:40'), w('10:05')];
    const due = today.filter(e => e.us && toMin(e.time) >= a && toMin(e.time) <= b);
    if (cal && !due.length) { console.log('gold: no US release in this window, nothing to report'); return; }
    extra.calendar = due; extra.calendarTitle = 'RELEASED (ET)';
  }
  if (slot === 'morning') { extra.calendar = today; extra.calendarTitle = 'TODAY (ET)'; }
  if (slot === 'midday') { extra.calendar = today.filter(e => toMin(e.time) > nowMin); extra.calendarTitle = 'STILL TO COME TODAY (ET)'; }
  if (!cal) delete extra.calendar;
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(GOLD_REPORT_STATE, 'utf8')); } catch { }
  if (!prev || prev.date !== uk.date || prev.slot === slot || !(prev.change || []).length) prev = null;
  extra.prevTitle = prev && prev.title.replace(/^\S+\s/, '');
  const task = { morning: 'GOLD MORNING BRIEF before London. Cover overnight news for gold and the dollar, today\'s calendar (ET times, with forecasts) and what matters most for gold today.',
    midday: 'GOLD BEFORE NEW YORK. What changed since the morning for gold and the dollar; the next US release and what result would flip the gold bias.',
    post1: 'GOLD DATA RESULT. Report the US release(s) listed as released: actual vs forecast, the reaction in gold, yields and the dollar, and whether the gold bias changes.',
    post2: 'GOLD DATA RESULT. Report the US release(s) listed as released: actual vs forecast, the reaction in gold, yields and the dollar, and whether the gold bias changes.' }[slot];
  const system = fs.readFileSync(path.join(__dirname, 'prompt_gold.md'), 'utf8');
  const user = `Today is ${uk.weekday} ${uk.date}, New York time now ${et()} ET. Write every time as New York time, like "08:30 ET".\nReport type: ${task}\n\n` +
    (prev ? `Earlier today the ${extra.prevTitle} (at ${prev.time} ET) had GOLD bias ${prev.bias} and said these would change it:\n${prev.change.map(c => '- ' + c).join('\n')}\n` +
      `In "scenarios", check each one: start with "✅ Happened", "❌ Didn't happen" or "⏳ Not known yet", then the evidence in a few words and what it means for the gold bias. Your bias now must agree with what happened.\n\n` : '') +
    `Latest prices (delayed, from a free feed; use these numbers):\n${goldNumbersText(n)}\n\n` +
    `Economic calendar today (US medium/high impact + big foreign releases; "actual" = already released):\n${cal ? (calendarLines(today).join('\n').replace(/\*\*/g, '') || 'nothing medium/high today') : 'not available'}\n\n` +
    `Headlines (free news feeds, newest first, each marked with its age). Anything older than about 12 h is from the previous session: do not describe it as happening today, and when it disagrees with today's price change above, trust the price change:\n${news.map(h => '- ' + h).join('\n') || 'none'}\n\n` +
    `Answer with the JSON object only.`;
  let embed;
  try {
    const r = parseJson(await callGemini(system, user, false));
    if (r.skip) { console.log('gold: nothing to report for this slot today'); return; }
    embed = buildGoldEmbed(slot, r, n, extra);
    if ((r.change || []).length) fs.writeFileSync(GOLD_REPORT_STATE, JSON.stringify({ date: uk.date, slot, time: et(), title: GOLD_TITLES[slot], bias: (r.bias || 'NEUTRAL').toUpperCase(), change: r.change }));
  } catch (e) {
    console.log('gold AI failed: ' + e.message);
    if (!['morning', 'midday'].includes(slot)) { await alert(`⚠️ **gold ${slot}** ${et()} ET: the gold AI report failed (${cut(e.message, 300)}) - nothing posted.`); return; }
    await alert(`⚠️ **gold ${slot}** ${et()} ET: the gold AI report failed (${cut(e.message, 300)}) - a basic gold report was posted instead.`);
    embed = backupGoldEmbed(slot, n);
  }
  await post(embed, process.env.GOLD_WEBHOOK, 'GOLD FUNDAMENTALS');
}

async function nqReport(uk, slot) {
  console.log(`report: ${slot} · UK ${uk.weekday} ${uk.date} ${uk.time}`);
  const t0 = Date.now();
  // morning: earnings for the rest of the week; earnings report: today only
  // (on Fridays: today + all of next week)
  const isFri = new Date(uk.date + 'T12:00:00Z').getUTCDay() === 5;
  const weekDates = []; for (let k = 0; k < (isFri ? 8 : 5); k++) { const d = addDays(uk.date, k), w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w >= 1 && w <= 5) weekDates.push(d); if (w === 5 && !isFri) break; }
  const [n, news, cal, earn] = await Promise.all([marketNumbers(), headlines(), calendar(uk.date),
    slot === 'morning' ? earnings(weekDates) : (slot === 'earnings' || slot === 'preny') ? earnings([uk.date]) : Promise.resolve([])]);
  const today = cal || [];
  console.log(`feeds took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`prices: ${n.nq ? 'NQ ok' : 'NQ missing'}, ${n.tnx ? '10y ok' : '10y missing'}, ${n.dxy ? 'DXY ok' : 'DXY missing'} · headlines: ${news.length} · calendar: ${cal ? today.length + ' US events today (' + today.filter(e => e.actual).length + ' released)' : 'missing'} · big earnings: ${earn.length}`);
  const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5), nowMin = toMin(uk.time);
  const extra = { today: uk.date };
  // result reports only run when something actually came out / reported - otherwise skip without using the AI
  if (slot === 'post1' || slot === 'post2') {
    const w = t => toMin(nyToUk(uk.date, t));   // windows in New York time, compared in UK time
    const [a, b] = slot === 'post1' ? [w('07:25'), w('08:35')] : [w('09:40'), w('10:05')];
    let due = today.filter(e => toMin(e.time) >= a && toMin(e.time) <= b);
    if (cal && !due.length) { console.log('no US release in this window today - skipped'); return; }
    // Nasdaq can take a few minutes to fill in the actual numbers - wait (up to 5 min) until they're all in
    for (let k = 0; k < 5 && due.some(e => !e.actual); k++) {
      console.log(`waiting for actual numbers (${due.filter(e => !e.actual).length} missing)...`);
      await new Promise(r => setTimeout(r, 60e3));
      const fresh = await calendar(uk.date);
      if (fresh) due = fresh.filter(e => toMin(e.time) >= a && toMin(e.time) <= b);
    }
    for (const e of today) { const f = due.find(x => x.title === e.title && x.time === e.time); if (f) e.actual = f.actual; }   // the AI sees the fresh numbers too
    if (due.some(e => !e.actual)) await alert(`⚠️ **${slot}**: some actual numbers were still missing after 5 min - posted with what was available.`, 0xf0b232);
    extra.calendar = due; extra.calendarTitle = 'RELEASED (ET)';
  }
  if (slot === 'earnings') {
    const ah = earn.filter(e => !e.pre);
    for (const e of ah) e.move = await extendedMove(e.symbol, false);
    const reported = ah.filter(e => e.actual || (e.move != null && Math.abs(e.move) >= 1.5) || /after/.test(e.when));
    if (!reported.length) { console.log('no big NQ company reported after the close today - skipped'); return; }
    extra.results = reported; extra.resultsTitle = 'RESULTS AFTER THE CLOSE'; extra.resultsPre = false;
  }
  if (slot === 'preny') {
    const pm = earn.filter(e => e.pre);
    for (const e of pm) e.move = await extendedMove(e.symbol, true);
    if (pm.length) { extra.results = pm; extra.resultsTitle = 'RESULTS BEFORE THE OPEN (big NQ companies)'; extra.resultsPre = true; }
  }
  if (slot === 'morning') { extra.calendar = today; extra.calendarTitle = 'TODAY (ET)'; extra.earnings = earn; }
  if (slot === 'midday' || slot === 'preny') { extra.calendar = today.filter(e => toMin(e.time) > nowMin); extra.calendarTitle = 'STILL TO COME TODAY (ET)'; }
  if (!cal) delete extra.calendar;

  // the previous report today and its "what would change it" scenarios
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(REPORT_STATE, 'utf8')); } catch { }
  if (!prev || prev.date !== uk.date || prev.slot === slot || !(prev.change || []).length) prev = null;
  extra.prevTitle = prev && prev.title.replace(/^\S+\s/, '');
  const system = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  const user = `Today is ${uk.weekday} ${uk.date}, New York time now ${et()} ET. Write every time as New York time, like "08:30 ET".\nReport type: ${slotTask(slot, uk.date)}\n\n` +
    (prev ? `Earlier today the ${extra.prevTitle} (at ${prev.time} ET) had NQ bias ${prev.bias} and said these would change it:\n${prev.change.map(c => '- ' + c).join('\n')}\n` +
      `In "scenarios", check each one: start with "✅ Happened", "❌ Didn't happen" or "⏳ Not known yet", then the evidence in a few words and what it means for the bias. Your bias now must agree with what happened.\n\n` : '') +
    `Latest prices (delayed, from a free feed; use these numbers):\n${numbersText(n)}\n\n` +
    `US economic calendar today (UK time; "actual" = already released):\n${cal ? (calendarLines(today).join('\n').replace(/\*\*/g, '') || 'nothing medium/high today') : 'not available'}\n\n` +
    (extra.results?.length ? `Earnings results today (from data feeds):\n${resultLines(extra.results, extra.resultsPre).join('\n').replace(/\*\*/g, '')}\n\n`
      : earn.length ? `Earnings of big Nasdaq-100 companies:\n${earningsLines(earn, uk.date).join('\n').replace(/\*\*/g, '')}\n\n` : '') +
    `Headlines (free news feeds, newest first, each marked with its age). Anything older than about 12 h is from the previous session: do not describe it as happening today, and when it disagrees with today's price change above, trust the price change:\n${news.map(h => '- ' + h).join('\n') || 'none'}\n\n` +
    `Search the web if you can for anything missing (results, guidance, reactions). Then answer with the JSON object only.`;
  let embed;
  try {
    const r = parseJson(await callGemini(system, user));
    if (r.skip) { console.log('nothing to report for this slot today - skipped'); return; }
    embed = buildEmbed(slot, r, n, extra);
    if ((r.change || []).length) fs.writeFileSync(REPORT_STATE, JSON.stringify({ date: uk.date, slot, time: et(), title: SLOTS[slot].title, bias: (r.bias || 'NEUTRAL').toUpperCase(), change: r.change }));
  } catch (e) {
    console.log('AI report failed: ' + e.message);
    await alert(`⚠️ **${slot}** ${et()} ET: the AI report failed (${cut(e.message, 300)}).\n${['morning', 'midday', 'preny'].includes(slot) ? 'A basic report was posted instead.' : 'Nothing was posted for this result report.'}`);
    if (!['morning', 'midday', 'preny'].includes(slot)) return;
    embed = backupEmbed(slot, n, uk.date);
  }
  if (!cal) await alert(`⚠️ **${slot}** ${et()} ET: the Nasdaq calendar could not be read - report posted without it.`, 0xf0b232);
  await post(embed);
}
