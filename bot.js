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
  earnings: { uk: '21:30', title: '📢 EARNINGS',             next: '07:00 UK' },
  health:   { uk: '21:50', title: '🩺 BOT HEALTH',           next: '' },   // daily check of today's runs -> #bot-health
};
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
  if (process.env.SLOT) return process.env.SLOT;
  const cron = (process.env.CRON || '').trim().split(/\s+/);
  if (cron.length < 2) return null;
  const hh = String((+cron[1] + uk.offset) % 24).padStart(2, '0'), mm = String(+cron[0]).padStart(2, '0');
  return Object.keys(SLOTS).find(k => SLOTS[k].uk === `${hh}:${mm}`) || null;
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
// free news headlines (RSS titles from the last day), so the report still has news when web search isn't available
async function headlines() {
  const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&apos;|&#39;|&#x2019;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const out = new Set();
  await Promise.all(FEEDS.map(async u => {
    try {
      const t = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT.feed) })).text();
      for (const m of [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10)) {
        const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1], date = (m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
        if (title && (!date || Date.now() - Date.parse(date) < 36 * 3600e3)) out.add(unesc(title));
      }
    } catch { }
  }));
  return [...out].slice(0, 40);
}
const JSON_H = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
const getJson = async u => (await fetch(u, { headers: JSON_H, signal: AbortSignal.timeout(TIMEOUT.feed) })).json();
const ukParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
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
async function calendar(ukDate) {
  try {
    return ((await getJson('https://api.nasdaq.com/api/calendar/economicevents?date=' + addDays(ukDate, 1))).data?.rows || [])
      .filter(x => x.country === 'United States' && !SKIP.test(x.eventName) && (HIGH.test(x.eventName) || MEDIUM.test(x.eventName)))
      .map(x => ({ time: nyToUk(ukDate, x.gmt), impact: HIGH.test(x.eventName) ? 'High' : 'Medium', title: x.eventName, forecast: clean(x.consensus), previous: clean(x.previous), actual: clean(x.actual) }))
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
          when: /after/.test(x.time) ? 'after the close (~21:00 UK)' : /pre/.test(x.time) ? 'before the open (~12:00-13:00 UK)' : 'time not given',
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

function slotTask(slot) {
  switch (slot) {
    case 'morning': return 'MORNING BRIEF before London. Cover overnight news, today\'s US calendar (UK times, with forecasts) and the big NQ earnings this week.';
    case 'midday': return 'MIDDAY UPDATE. What changed since the morning; the next release and what result would flip the bias.';
    case 'post1': return 'DATA RESULT. If NO high-impact US release came out between 12:25 and 13:35 UK time today, return {"skip": true}. Otherwise report actual vs forecast, the immediate reaction in yields/NQ, and whether the bias changes.';
    case 'post2': return 'DATA RESULT. If NO high-impact or medium-impact US release came out between 14:40 and 15:05 UK time today, return {"skip": true}. Otherwise report actual vs forecast, the reaction, and whether the bias changes.';
    case 'earnings': return 'EARNINGS RESULT for the big Nasdaq-100 companies that reported after the US close today (listed below with EPS vs expected and the after-hours move). If the headlines and data show none of them has actually reported yet, return {"skip": true}. Otherwise for each: revenue and guidance vs expected if the headlines say, why the stock is moving, what it means for NQ, and the NQ bias for tomorrow. Put the key facts in "result".';
    case 'preny': return 'BEFORE THE NY OPEN (14:30 UK). Bias for the cash session, what to watch in the first hours, the next release. If big companies reported before the open (listed below), explain their results and pre-market moves in "result".';
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
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT.ai) });
      const j = await r.json();
      if (!r.ok) { lastErr = new Error(`${tag}: ${r.status}`); console.log(`${tag}: ${r.status} ${JSON.stringify(j.error || j).slice(0, 1500)}`); continue; }
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
function calendarLines(evts) { return evts.map(e => `${e.time} ${e.impact === 'High' ? '🔴' : '🟠'} ${e.title}${e.actual ? ` · actual **${e.actual}**` : ''}${e.forecast ? ` · forecast ${e.forecast}` : ''}${e.previous ? ` · previous ${e.previous}` : ''}`); }
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
    footer: { text: `${DISCLAIMER} · next report ${SLOTS[slot].next} · calendar & earnings: Nasdaq` },
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
    title: `${SLOTS[slot].title} (basic)`,
    description: `__**NQ bias ${bias}**__\n` + numbersText(n) + `\n\nRule: NQ up, yield down and dollar down each count bullish (opposite = bearish). Score ${sgn(score)} of ${used}.\nThe full AI report was not available this time.`,
    color: COLOR[bias], footer: { text: `${DISCLAIMER} · next report ${SLOTS[slot].next}` }, timestamp: new Date().toISOString(),
  };
}

async function post(embed, webhook = process.env.DISCORD_WEBHOOK, username = 'FUNDAMENTALS') {
  const body = { username, embeds: [embed] };
  if (process.env.DRY === '1') { console.log(JSON.stringify(body, null, 2)); return; }
  if (!webhook) throw new Error('webhook not set');
  const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT.discord) });
  if (!r.ok) throw new Error(`Discord ${r.status} ${await r.text()}`);
  console.log(username === 'FUNDAMENTALS' ? 'posted to Discord' : 'health message sent');
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
  const seen = {}, lines = [];
  for (const run of runs.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (run.id === +process.env.GITHUB_RUN_ID) continue;
    const jobs = (await (await api(`/actions/runs/${run.id}/jobs`)).json()).jobs || [];
    let log = ''; try { if (jobs[0]) log = await (await api(`/actions/jobs/${jobs[0].id}/logs`)).text(); } catch { }
    if (/health check started/.test(log) || (run.status !== 'completed' && !log)) {  // other health checks, or a run still going
      if (run.status !== 'completed' && !/health check started/.test(log)) lines.push(`⏳ run #${run.run_number} still running`);
      continue;
    }
    const slot = (log.match(/report: (\w+)/) || [])[1];
    if (!slot && /no report due/.test(log)) continue;                       // the other season's timer
    const t = ukParts(new Date(run.updated_at)), at = `${t.hour}:${t.minute}`, late = Math.round((Date.parse(run.run_started_at) - Date.parse(run.created_at)) / 60e3);
    const manual = run.event === 'workflow_dispatch' ? ' (manual test)' : '';
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
  const missing = REPORT_SLOTS.filter(s => !seen[s] && (+SLOTS[s].uk.slice(0, 2) * 60 + +SLOTS[s].uk.slice(3, 5)) + 30 < nowMin);
  for (const s of missing) lines.push(`❓ **${s}** (${SLOTS[s].uk}): no run found - GitHub didn't start it`);
  const bad = lines.filter(l => /^(❌|⚠️|❓)/.test(l) && !/manual test/.test(l)).length;   // manual tests don't count as problems
  await alert(`**🩺 BOT HEALTH · ${uk.weekday} ${uk.date}** - ${bad ? bad + ' problem(s)' : 'all good'}\n\n${lines.join('\n') || 'no runs today'}`, bad ? 0xf85149 : 0x3fb950);
}

(async () => {
  const uk = ukNow();
  const slot = pickSlot(uk);
  if (!slot || !SLOTS[slot]) { console.log(`no report due (UK ${uk.time}, cron "${process.env.CRON || ''}") - other season's timer, exiting`); return; }
  if (slot === 'health') { console.log('health check started'); await healthCheck(uk); return; }
  status.slot = slot;
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
    const [a, b] = slot === 'post1' ? [toMin('12:25'), toMin('13:35')] : [toMin('14:40'), toMin('15:05')];
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
    extra.calendar = due; extra.calendarTitle = 'RELEASED (UK TIME)';
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
  if (slot === 'morning') { extra.calendar = today; extra.calendarTitle = 'TODAY (UK TIME)'; extra.earnings = earn; }
  if (slot === 'midday' || slot === 'preny') { extra.calendar = today.filter(e => toMin(e.time) > nowMin); extra.calendarTitle = 'STILL TO COME TODAY (UK TIME)'; }
  if (!cal) delete extra.calendar;

  const system = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  const user = `Today is ${uk.weekday} ${uk.date}, UK time now ${uk.time}.\nReport type: ${slotTask(slot)}\n\n` +
    `Latest prices (delayed, from a free feed; use these numbers):\n${numbersText(n)}\n\n` +
    `US economic calendar today (UK time; "actual" = already released):\n${cal ? (calendarLines(today).join('\n').replace(/\*\*/g, '') || 'nothing medium/high today') : 'not available'}\n\n` +
    (extra.results?.length ? `Earnings results today (from data feeds):\n${resultLines(extra.results, extra.resultsPre).join('\n').replace(/\*\*/g, '')}\n\n`
      : earn.length ? `Earnings of big Nasdaq-100 companies:\n${earningsLines(earn, uk.date).join('\n').replace(/\*\*/g, '')}\n\n` : '') +
    `Today's headlines (free news feeds):\n${news.map(h => '- ' + h).join('\n') || 'none'}\n\n` +
    `Search the web if you can for anything missing (results, guidance, reactions). Then answer with the JSON object only.`;
  let embed;
  try {
    const r = parseJson(await callGemini(system, user));
    if (r.skip) { console.log('nothing to report for this slot today - skipped'); return; }
    embed = buildEmbed(slot, r, n, extra);
  } catch (e) {
    console.log('AI report failed: ' + e.message);
    await alert(`⚠️ **${slot}** ${uk.time} UK: the AI report failed (${cut(e.message, 300)}).\n${['morning', 'midday', 'preny'].includes(slot) ? 'A basic report was posted instead.' : 'Nothing was posted for this result report.'}`);
    if (!['morning', 'midday', 'preny'].includes(slot)) return;
    embed = backupEmbed(slot, n);
  }
  if (!cal) await alert(`⚠️ **${slot}** ${uk.time} UK: the Nasdaq calendar could not be read - report posted without it.`, 0xf0b232);
  await post(embed);
})().then(() => process.exit(0), async e => { console.error(e); await alert(`❌ **${status.slot || 'bot'}**: crashed - ${cut(e.message, 500)}`); process.exit(1); });
