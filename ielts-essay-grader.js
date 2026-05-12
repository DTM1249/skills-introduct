require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a certified IELTS examiner with 15 years of experience. Grade the following IELTS General Training Task 2 essay on four criteria exactly as IELTS examiners do:
- Task Achievement (TA): Does it address the question? Clear position? Developed ideas?
- Coherence & Cohesion (CC): Logical structure? Appropriate linking? Paragraph flow?
- Lexical Resource (LR): Vocabulary range? Accuracy? Paraphrasing?
- Grammatical Range & Accuracy (GRA): Sentence variety? Accuracy? Complex structures?
For each criterion: give a band score (5.0–9.0 in 0.5 increments), 2 specific strengths, and 2 specific improvements with example rewrites. Then give the overall band score (average of 4 criteria). Finally list 5 specific sentences from the essay that need improvement and rewrite each one at Band 7.5 level.`;

const ESSAYS_DIR = path.join(__dirname, 'essays');
const SCORES_FILE = path.join(__dirname, 'scores.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadScores() {
  if (!fs.existsSync(SCORES_FILE)) return [];
  return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
}

function saveScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

function getNextEssayNumber(dateStr) {
  ensureDir(ESSAYS_DIR);
  const existing = fs.readdirSync(ESSAYS_DIR).filter(f => f.startsWith(dateStr));
  return existing.length + 1;
}

function extractBandScores(feedback) {
  const criteria = { TA: null, CC: null, LR: null, GRA: null, overall: null };
  const patterns = [
    { key: 'TA', re: /Task Achievement[^:]*:\s*(?:Band\s*)?(\d+(?:\.\d+)?)/i },
    { key: 'CC', re: /Coherence[^:]*:\s*(?:Band\s*)?(\d+(?:\.\d+)?)/i },
    { key: 'LR', re: /Lexical Resource[^:]*:\s*(?:Band\s*)?(\d+(?:\.\d+)?)/i },
    { key: 'GRA', re: /Grammatical[^:]*:\s*(?:Band\s*)?(\d+(?:\.\d+)?)/i },
    { key: 'overall', re: /[Oo]verall[^:]*[Bb]and[^:]*:\s*(?:Band\s*)?(\d+(?:\.\d+)?)|[Oo]verall[^:]*:\s*(?:Band\s*)?(\d+(?:\.\d+)?)/i },
  ];
  for (const { key, re } of patterns) {
    const m = feedback.match(re);
    if (m) criteria[key] = parseFloat(m[1] || m[2]);
  }
  return criteria;
}

function showSummary() {
  const scores = loadScores();
  if (scores.length === 0) {
    console.log('No essays graded yet.');
    return;
  }

  console.log('\n=== IELTS Essay Progress Summary ===\n');
  console.log(`Total essays graded: ${scores.length}\n`);

  const criteria = ['TA', 'CC', 'LR', 'GRA', 'overall'];
  const criteriaNames = {
    TA: 'Task Achievement',
    CC: 'Coherence & Cohesion',
    LR: 'Lexical Resource',
    GRA: 'Grammatical Range & Accuracy',
    overall: 'Overall Band',
  };

  console.log('--- All Essay Scores ---');
  scores.forEach((entry, i) => {
    console.log(`\n[${i + 1}] ${entry.date} (${entry.file})`);
    console.log(`    TA: ${entry.bands.TA ?? 'N/A'}  CC: ${entry.bands.CC ?? 'N/A'}  LR: ${entry.bands.LR ?? 'N/A'}  GRA: ${entry.bands.GRA ?? 'N/A'}  |  Overall: ${entry.bands.overall ?? 'N/A'}`);
  });

  console.log('\n--- Averages Per Criterion ---');
  for (const key of criteria) {
    const vals = scores.map(s => s.bands[key]).filter(v => v !== null && v !== undefined);
    if (vals.length === 0) continue;
    const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    console.log(`  ${criteriaNames[key]}: ${avg}`);
  }

  if (scores.length >= 2) {
    console.log('\n--- Trend (Overall Band) ---');
    const overalls = scores.map((s, i) => ({ n: i + 1, date: s.date, score: s.bands.overall })).filter(s => s.score !== null && s.score !== undefined);
    if (overalls.length >= 2) {
      const first = overalls[0].score;
      const last = overalls[overalls.length - 1].score;
      const change = (last - first).toFixed(1);
      const direction = change > 0 ? '↑' : change < 0 ? '↓' : '→';
      console.log(`  First essay: ${first}  →  Latest essay: ${last}  (${direction} ${Math.abs(change)} bands)`);
      overalls.forEach(({ n, date, score }) => {
        const bar = '█'.repeat(Math.round((score - 4) * 2));
        console.log(`  Essay ${n} (${date}): ${score} ${bar}`);
      });
    }
  }
  console.log('');
}

async function readEssayFromStdin() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nPaste your IELTS Task 2 essay below.');
  console.log('When done, press Enter then Ctrl+D (or type END on a new line):\n');

  return new Promise((resolve) => {
    const lines = [];
    rl.on('line', (line) => {
      if (line.trim() === 'END') {
        rl.close();
      } else {
        lines.push(line);
      }
    });
    rl.on('close', () => resolve(lines.join('\n').trim()));
  });
}

async function gradeEssay(essay) {
  console.log('\n=== Grading your essay... ===\n');

  let fullFeedback = '';

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: essay }],
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      process.stdout.write(chunk.delta.text);
      fullFeedback += chunk.delta.text;
    }
  }

  console.log('\n');
  return fullFeedback;
}

function saveEssay(essay, feedback) {
  ensureDir(ESSAYS_DIR);
  const today = new Date().toISOString().slice(0, 10);
  const n = getNextEssayNumber(today);
  const filename = `${today}-essay-${n}.json`;
  const filepath = path.join(ESSAYS_DIR, filename);

  const bands = extractBandScores(feedback);
  const record = { date: today, essay, feedback, bands };

  fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
  console.log(`Essay saved to essays/${filename}`);

  const scores = loadScores();
  scores.push({ date: today, file: filename, bands });
  saveScores(scores);
  console.log(`Scores updated in scores.json\n`);

  return { filename, bands };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--summary')) {
    showSummary();
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set. Create a .env file with ANTHROPIC_API_KEY=your_key');
    process.exit(1);
  }

  let essay = '';

  const fileArg = args.find(a => a.endsWith('.txt'));
  if (fileArg) {
    essay = fs.readFileSync(fileArg, 'utf8').trim();
  } else if (args.length > 0 && !args[0].startsWith('--')) {
    essay = args.join(' ').trim();
  } else {
    essay = await readEssayFromStdin();
  }

  if (!essay) {
    console.error('Error: No essay provided.');
    process.exit(1);
  }

  const feedback = await gradeEssay(essay);
  const { filename, bands } = saveEssay(essay, feedback);

  console.log('=== Band Score Summary ===');
  console.log(`  Task Achievement:              ${bands.TA ?? 'N/A'}`);
  console.log(`  Coherence & Cohesion:          ${bands.CC ?? 'N/A'}`);
  console.log(`  Lexical Resource:              ${bands.LR ?? 'N/A'}`);
  console.log(`  Grammatical Range & Accuracy:  ${bands.GRA ?? 'N/A'}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Overall Band:                  ${bands.overall ?? 'N/A'}`);
  console.log('');
  console.log(`Run "node ielts-essay-grader.js --summary" to see your progress.\n`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
