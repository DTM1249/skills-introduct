#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const nodemailer = require('nodemailer');
const path = require('path');

const SCORES_FILE = path.join(__dirname, 'scores.json');
const EXAM_DATE = new Date('2026-06-20');

// ─── IELTS Band Score Helpers ────────────────────────────────────────────────

function roundToHalfBand(raw) {
  return Math.round(raw * 2) / 2;
}

function calcOverall(listening, reading, writingAvg, speaking) {
  const sum = listening + reading + writingAvg + (speaking ?? writingAvg);
  const avg = sum / 4;
  return roundToHalfBand(avg);
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function loadScores() {
  if (!fs.existsSync(SCORES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

// ─── Prompt Helper ───────────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function promptScore(rl, label, allowEmpty = false) {
  while (true) {
    const raw = await prompt(rl, `  ${label}: `);
    if (allowEmpty && raw.trim() === '') return null;
    const val = parseFloat(raw);
    if (!isNaN(val) && val >= 0 && val <= 9) return roundToHalfBand(val);
    console.log('  Enter a number between 0 and 9 (or press Enter to skip).');
  }
}

// ─── Days Remaining ──────────────────────────────────────────────────────────

function daysUntilExam() {
  const now = new Date();
  const diff = EXAM_DATE - now;
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ─── Trend Analysis ──────────────────────────────────────────────────────────

function analyzeTrend(values) {
  if (values.length < 2) return { label: 'N/A (need ≥2 tests)', slope: 0 };
  const n = values.length;
  const x = values.map((_, i) => i);
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  const num = x.reduce((sum, xi, i) => sum + (xi - meanX) * (values[i] - meanY), 0);
  const den = x.reduce((sum, xi) => sum + (xi - meanX) ** 2, 0);
  const slope = den === 0 ? 0 : num / den;

  let label;
  if (slope > 0.1) label = '↑ Improving';
  else if (slope < -0.1) label = '↓ Declining';
  else label = '→ Plateauing';

  return { label, slope };
}

// slope per day using linear regression on date axis
function analyzeTrendByDate(scores, key) {
  const pts = scores
    .filter(s => s[key] !== null && s[key] !== undefined)
    .map(s => ({ x: new Date(s.date).getTime() / 86400000, y: s[key] }));
  if (pts.length < 2) return { slope: 0 };
  const n = pts.length;
  const meanX = pts.reduce((a, p) => a + p.x, 0) / n;
  const meanY = pts.reduce((a, p) => a + p.y, 0) / n;
  const num = pts.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0);
  const den = pts.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  return { slope: den === 0 ? 0 : num / den, lastY: pts[pts.length - 1].y };
}

function projectScore(scores, daysAhead) {
  if (scores.length < 2) return null;
  const { slope, lastY } = analyzeTrendByDate(scores, 'overall');
  const projected = lastY + slope * daysAhead;
  return Math.min(9, Math.max(0, roundToHalfBand(projected)));
}

// ─── LOG Command ─────────────────────────────────────────────────────────────

async function logScore() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n=== Log IELTS Mock Test Score ===\n');

  const dateInput = await prompt(rl, '  Date (YYYY-MM-DD, Enter for today): ');
  const date = dateInput.trim() || new Date().toISOString().slice(0, 10);

  const scores = loadScores();
  const testNumber = await prompt(rl, `  Test number (Enter for ${scores.length + 1}): `);
  const num = testNumber.trim() ? parseInt(testNumber, 10) : scores.length + 1;

  console.log('\n  Enter band scores (0–9, halves accepted e.g. 6.5):');
  const listening = await promptScore(rl, 'Listening');
  const reading = await promptScore(rl, 'Reading');
  const writing1 = await promptScore(rl, 'Writing Task 1');
  const writing2 = await promptScore(rl, 'Writing Task 2');
  const speaking = await promptScore(rl, 'Speaking (Enter to skip)', true);

  rl.close();

  const writingAvg = roundToHalfBand((writing1 + writing2) / 2);
  const overall = calcOverall(listening, reading, writingAvg, speaking);

  const entry = { date, testNumber: num, listening, reading, writing1, writing2, writingAvg, speaking, overall };
  scores.push(entry);
  saveScores(scores);

  console.log(`\n  ✔ Saved. Overall band: ${overall}`);
  if (speaking === null) console.log('  (Speaking not entered — overall calculated using Writing average as proxy)');
}

// ─── TABLE Rendering ─────────────────────────────────────────────────────────

function pad(str, len, align = 'right') {
  const s = String(str ?? '-');
  if (align === 'left') return s.padEnd(len);
  return s.padStart(len);
}

function renderTable(scores) {
  const cols = [
    { h: 'Date',     k: 'date',       w: 12, a: 'left' },
    { h: '#',        k: 'testNumber', w:  3 },
    { h: 'Listen',   k: 'listening',  w:  7 },
    { h: 'Reading',  k: 'reading',    w:  8 },
    { h: 'Writ T1',  k: 'writing1',   w:  8 },
    { h: 'Writ T2',  k: 'writing2',   w:  8 },
    { h: 'Writing',  k: 'writingAvg', w:  8 },
    { h: 'Speaking', k: 'speaking',   w:  9 },
    { h: 'Overall',  k: 'overall',    w:  8 },
  ];

  const sep = '├' + cols.map(c => '─'.repeat(c.w + 2)).join('┼') + '┤';
  const top = '┌' + cols.map(c => '─'.repeat(c.w + 2)).join('┬') + '┐';
  const bot = '└' + cols.map(c => '─'.repeat(c.w + 2)).join('┴') + '┘';
  const row = cells => '│' + cells.map((v, i) => ` ${pad(v, cols[i].w, cols[i].a)} `).join('│') + '│';

  const lines = [top, row(cols.map(c => pad(c.h, c.w, c.a))), sep];
  for (const s of scores) {
    lines.push(row(cols.map(c => s[c.k] ?? '-')));
  }
  lines.push(bot);
  return lines.join('\n');
}

// ─── REPORT Command ──────────────────────────────────────────────────────────

function report() {
  const scores = loadScores();
  if (scores.length === 0) {
    console.log('\nNo scores logged yet. Run: node ielts-progress-tracker.js --log\n');
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('               IELTS PROGRESS REPORT');
  console.log('═══════════════════════════════════════════════════════\n');

  // Table
  console.log(renderTable(scores));

  // Sections
  const sections = {
    Listening: scores.map(s => s.listening),
    Reading:   scores.map(s => s.reading),
    Writing:   scores.map(s => s.writingAvg),
    Speaking:  scores.filter(s => s.speaking !== null).map(s => s.speaking),
    Overall:   scores.map(s => s.overall),
  };

  // Trend analysis
  console.log('\n─── Score Trends ──────────────────────────────────────\n');
  const trendData = {};
  for (const [section, vals] of Object.entries(sections)) {
    if (vals.length === 0) continue;
    const trend = analyzeTrend(vals);
    const latest = vals[vals.length - 1];
    trendData[section] = { trend, vals, latest };
    console.log(`  ${section.padEnd(10)} Latest: ${String(latest).padStart(3)}   Trend: ${trend.label}`);
  }

  // Projection
  const days = daysUntilExam();
  console.log('\n─── Projection ────────────────────────────────────────\n');
  console.log(`  Days until exam (June 20, 2026): ${days}`);

  const projected = projectScore(scores, days);
  if (projected !== null) {
    console.log(`  At current rate, projected exam score = ${projected}`);
  } else {
    console.log('  Log at least 2 tests for a projection.');
  }

  // Sections to prioritise (lowest average)
  console.log('\n─── Sections to Prioritise ────────────────────────────\n');
  const avgs = Object.entries(sections)
    .filter(([s, v]) => v.length > 0 && s !== 'Overall')
    .map(([s, v]) => [s, v.reduce((a, b) => a + b, 0) / v.length])
    .sort((a, b) => a[1] - b[1]);

  for (const [s, avg] of avgs.slice(0, 2)) {
    console.log(`  ★ ${s} (avg ${avg.toFixed(1)}) — needs most attention`);
  }
  for (const [s, avg] of avgs.slice(2)) {
    console.log(`    ${s} (avg ${avg.toFixed(1)})`);
  }

  console.log('\n═══════════════════════════════════════════════════════\n');
}

// ─── EMAIL Command ───────────────────────────────────────────────────────────

function buildAsciiChart(scores) {
  const sections = ['listening', 'reading', 'writingAvg', 'speaking', 'overall'];
  const labels   = ['Listen', 'Reading', 'Writing', 'Speaking', 'Overall'];
  const rows = [];

  for (let band = 9; band >= 4; band -= 0.5) {
    const cells = sections.map(s => {
      const last = scores[scores.length - 1][s];
      return last !== null && last >= band ? '█' : ' ';
    });
    rows.push(`${String(band).padStart(4)} │ ${cells.join('  ')} │`);
  }

  const header = '       ' + labels.map(l => l.padEnd(7)).join(' ');
  const divider = '─────┼' + '─'.repeat(labels.length * 8 + 2) + '┤';
  return [header, divider, ...rows].join('\n');
}

function buildHtmlReport(scores) {
  const sections = {
    Listening: scores.map(s => s.listening),
    Reading:   scores.map(s => s.reading),
    Writing:   scores.map(s => s.writingAvg),
    Speaking:  scores.filter(s => s.speaking !== null).map(s => s.speaking),
    Overall:   scores.map(s => s.overall),
  };

  const days = daysUntilExam();
  const projected = projectScore(scores, days);

  const rowsHtml = scores.map(s => `
    <tr>
      <td>${s.date}</td><td>${s.testNumber}</td>
      <td>${s.listening}</td><td>${s.reading}</td>
      <td>${s.writing1}</td><td>${s.writing2}</td>
      <td>${s.writingAvg}</td><td>${s.speaking ?? '-'}</td>
      <td><strong>${s.overall}</strong></td>
    </tr>`).join('');

  const trendRows = Object.entries(sections)
    .filter(([, v]) => v.length > 0)
    .map(([section, vals]) => {
      const { label } = analyzeTrend(vals);
      const latest = vals[vals.length - 1];
      const color = label.startsWith('↑') ? '#22c55e' : label.startsWith('↓') ? '#ef4444' : '#f59e0b';
      return `<tr>
        <td>${section}</td>
        <td>${latest}</td>
        <td style="color:${color};font-weight:bold">${label}</td>
      </tr>`;
    }).join('');

  const chartBars = ['listening', 'reading', 'writingAvg', 'speaking', 'overall'].map((k, i) => {
    const labels = ['Listening', 'Reading', 'Writing', 'Speaking', 'Overall'];
    const last = scores[scores.length - 1][k] ?? 0;
    const pct = (last / 9 * 100).toFixed(1);
    const color = last >= 7 ? '#22c55e' : last >= 5.5 ? '#f59e0b' : '#ef4444';
    return `
      <div style="margin:8px 0">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="width:80px;font-size:13px">${labels[i]}</span>
          <div style="flex:1;background:#e5e7eb;border-radius:4px;height:20px">
            <div style="width:${pct}%;background:${color};height:20px;border-radius:4px;display:flex;align-items:center;padding-left:6px;color:white;font-size:12px">${last}</div>
          </div>
        </div>
      </div>`;
  }).join('');

  // Recommended focus
  const avgs = Object.entries(sections)
    .filter(([s, v]) => v.length > 0 && s !== 'Overall')
    .map(([s, v]) => [s, v.reduce((a, b) => a + b, 0) / v.length])
    .sort((a, b) => a[1] - b[1]);

  const focus = avgs.slice(0, 2).map(([s, avg]) => `<li><strong>${s}</strong> (avg ${avg.toFixed(1)}) — prioritise this week</li>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #1f2937; }
  h1 { background: #1e40af; color: white; padding: 16px; border-radius: 8px; }
  h2 { color: #1e40af; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
  th { background: #1e40af; color: white; padding: 8px; }
  td { padding: 7px 8px; border: 1px solid #e5e7eb; }
  tr:nth-child(even) td { background: #f9fafb; }
  .box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .projection { font-size: 22px; font-weight: bold; color: #1e40af; }
</style></head>
<body>
  <h1>IELTS Progress Report</h1>

  <div class="box">
    <div>Exam Date: <strong>June 20, 2026</strong> &nbsp;|&nbsp; Days Remaining: <strong>${days}</strong></div>
    ${projected !== null ? `<div class="projection">Projected Score: ${projected}</div>` : '<div>Log at least 2 tests for a projection.</div>'}
  </div>

  <h2>Score History</h2>
  <table>
    <tr>
      <th>Date</th><th>#</th><th>Listen</th><th>Reading</th>
      <th>Writ T1</th><th>Writ T2</th><th>Writing</th><th>Speaking</th><th>Overall</th>
    </tr>
    ${rowsHtml}
  </table>

  <h2>Section Trends</h2>
  <table>
    <tr><th>Section</th><th>Latest</th><th>Trend</th></tr>
    ${trendRows}
  </table>

  <h2>Score Chart (Latest Test)</h2>
  ${chartBars}

  <h2>Recommended Focus This Week</h2>
  <ul>${focus}</ul>
</body>
</html>`;
}

async function sendEmail() {
  const scores = loadScores();
  if (scores.length === 0) {
    console.log('\nNo scores to report. Log at least one test first.\n');
    return;
  }

  const { GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RECIPIENT } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('\nError: Set GMAIL_USER and GMAIL_APP_PASSWORD in your .env file.\n');
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const html = buildHtmlReport(scores);
  const days = daysUntilExam();
  const projected = projectScore(scores, days);
  const subject = `IELTS Progress Report — ${days} days to exam${projected ? ` | Projected: ${projected}` : ''}`;

  await transporter.sendMail({
    from: `"IELTS Tracker" <${GMAIL_USER}>`,
    to: EMAIL_RECIPIENT || GMAIL_USER,
    subject,
    html,
  });

  console.log(`\n  Email sent to ${EMAIL_RECIPIENT || GMAIL_USER}\n`);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === '--log') {
  logScore().catch(err => { console.error(err); process.exit(1); });
} else if (arg === '--report') {
  report();
} else if (arg === '--email') {
  sendEmail().catch(err => { console.error(err.message); process.exit(1); });
} else {
  console.log(`
IELTS Progress Tracker
  --log     Log a mock test score
  --report  Show progress report in terminal
  --email   Send HTML progress report to Gmail
`);
}
