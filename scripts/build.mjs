import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname, basename, relative, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CONCEPTS_DIR = join(PROJECT_ROOT, 'concepts');
const CONTENT_DIR = join(PROJECT_ROOT, 'content');
const JS_DIR = join(PROJECT_ROOT, 'js');

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines.length < 2 || lines[0].trim() !== '---') return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { endIdx = i; break; }
  }
  if (endIdx < 0) return null;
  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join('\n').trim();
  const data = {};
  let currentKey = null;
  let inList = false;
  for (const raw of fmLines) {
    const line = raw.trim();
    if (!line) continue;
    if (inList && /^\s*-\s+/.test(line)) {
      const val = line.replace(/^\s*-\s+/, '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (Array.isArray(data[currentKey])) { data[currentKey].push(val); }
      continue;
    }
    inList = false;
    const match = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let val = match[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    if (val === '[' || val.startsWith('[')) {
      if (val === '[]') { data[key] = []; continue; }
      if (val === '[') { data[key] = []; currentKey = key; inList = true; continue; }
      const listMatch = val.match(/^\[(.*)\]$/);
      if (listMatch) {
        const items = listMatch[1].split(',').map(i => i.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')).filter(i => i);
        data[key] = items;
        continue;
      }
    }
    currentKey = key;
    data[key] = val;
  }
  return { data, body };
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(text) {
  let t = text;
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function renderMarkdown(md, language = 'cpp') {
  const lines = md.split('\n');
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim() || language;
      if (lang === 'mermaid') {
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
        i++;
        const code = codeLines.join('\n');
        parts.push(`<div class="mermaid-wrapper"><pre class="mermaid">${escapeHtml(code)}</pre></div>`);
        continue;
      }
      if (lang === 'html') {
        const htmlLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { htmlLines.push(lines[i]); i++; }
        i++;
        parts.push(htmlLines.join('\n'));
        continue;
      }
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++;
      const code = codeLines.join('\n');
      parts.push(`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`);
      continue;
    }
    if (/^#+\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const text = line.replace(/^#+\s+/, '').trim();
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (level === 2) parts.push(`<h2 id="section-${id}">${renderInline(text)}</h2>`);
      else if (level === 3) parts.push(`<h3 id="section-${id}">${renderInline(text)}</h3>`);
      else if (level === 4) parts.push(`<h4 id="section-${id}">${renderInline(text)}</h4>`);
      else parts.push(`<h${level} id="section-${id}">${renderInline(text)}</h${level}>`);
      i++; continue;
    }
    if (/^>\s/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>/.test(lines[i])) { quoteLines.push(lines[i].replace(/^>\s?/, '')); i++; }
      parts.push(`<blockquote>${quoteLines.join('<br>')}</blockquote>`);
      continue;
    }
    // Collect paragraph lines (stop at blank, block elements, or certain patterns)
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l) || /^```/.test(l) || /^#+\s/.test(l) || /^>/.test(l)) break;
      paraLines.push(l);
      i++;
    }
    if (paraLines.length === 0) continue;
    const joined = paraLines.join('\n');
    // Check for list (single line starting with - or *)
    if (/^\s*[-*]\s/.test(paraLines[0])) {
      parts.push('<ul>');
      for (const item of paraLines) {
        if (/^\s*[-*]\s/.test(item)) {
          parts.push(`<li>${renderInline(item.replace(/^\s*[-*]\s+/, ''))}</li>`);
        } else if (!/^\s*$/.test(item)) {
          parts.push(`<li>${renderInline(item.trim())}</li>`);
        }
      }
      parts.push('</ul>');
    } else {
      parts.push(`<p>${renderInline(joined)}</p>`);
    }
  }
  return parts.join('\n');
}

function scanConcepts() {
  const entries = [];
  function walk(dir) {
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.name === 'index.md' || item.name === 'log.md') continue;
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.name.endsWith('.md')) {
        const rel = relative(CONCEPTS_DIR, fullPath);
        const segments = rel.split('/');
        const phaseDir = segments.length >= 2 ? segments[0] : '';
        const fileName = item.name.replace(/\.md$/, '');
        const phaseNum = getPhaseNumber(phaseDir);
        const phaseName = getPhaseName(phaseNum);
        entries.push({ filePath: fullPath, fileName, phaseDir, phase: phaseNum, phaseName, relPath: rel });
      }
    }
  }
  walk(CONCEPTS_DIR);
  return entries;
}

const PHASE_NAMES = {
  1: 'Foundations', 2: 'Mathematics & Statistics', 3: 'C++ Low-Latency Patterns',
  4: 'System Programming & IPC', 5: 'Kernel Bypass & Protocols', 6: 'Network Hardware',
  7: 'Order Entry & Execution', 8: 'Exchange Architecture', 9: 'Order Book & Microstructure',
  10: 'Trading Strategies', 11: 'Backtesting & Simulation', 12: 'Data Engineering',
  13: 'FPGA & Hardware Acceleration', 14: 'Monitoring & Security',
  15: 'Testing & Production', 16: 'HFT Economics & Career', 17: 'Production Failure Modes & Recovery',
};

const PHASE_DIR_MAP = {
  'foundations': 1, 'mathematics': 2, 'cpp-patterns': 3, 'system-programming': 4,
  'kernel-bypass': 5, 'network-hardware': 6, 'order-entry': 7, 'exchange-architecture': 8,
  'order-book': 9, 'trading-strategies': 10, 'backtesting': 11, 'data-engineering': 12,
  'fpga': 13, 'monitoring': 14, 'testing-production': 15, 'economics-career': 16, 'failure-modes': 17,
};

function getPhaseNumber(dirName) { return PHASE_DIR_MAP[dirName] || 0; }
function getPhaseName(phaseNum) { return PHASE_NAMES[phaseNum] || `Phase ${phaseNum}`; }

function parseConceptFile(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    const name = basename(filePath);
    console.warn(`  Warning: ${name} has no valid frontmatter, using defaults`);
    return { id: basename(filePath).replace(/\.md$/, ''), title: '', description: '', tags: [], type: 'reference', phase: 0, phaseName: '', category: '', language: 'cpp', performanceTarget: '', tradeoff: '', body: text, artifactId: '', subcategory: '' };
  }
  const fm = parsed.data;
  const body = parsed.body;
  const id = basename(filePath).replace(/\.md$/, '');
  return {
    id, title: fm.title || id.replace(/-/g, ' '), description: fm.description || '',
    tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
    type: fm.type || 'reference', phase: parseInt(fm.phase, 10) || 0,
    phaseName: fm.phaseName || '', category: fm.category || '', subcategory: fm.subcategory || '',
    language: fm.language || 'cpp', performanceTarget: fm['performance-target'] || '',
    tradeoff: fm.tradeoff || '', body, artifactId: fm['artifact-id'] || id,
  };
}

const TAG_MAP = {
  'cache|coherency|false.sharing|memory.model': 'cache-coherency',
  'lock.free|wait.free|lockfree|spinlock': 'lock-free',
  'memory.pool|allocator|numa|huge.page': 'memory-management',
  'template|metaprogram|constexpr|sfinae|crtp': 'template-metaprogramming',
  'simd|vectorize|intrinsic|avx|sse|neon': 'simd',
  'branch|predict|inline|unroll|optimiz': 'compiler-optimization',
  'rdma|roce|infiniband|verbs': 'rdma',
  'dpdk|kernel.bypass|xdp': 'kernel-bypass',
  'tcp|udp|congestion|nagle|tcp.nodelay': 'networking',
  'fpga|hdl|hls|rtl|verilog|vhdl|pcie': 'fpga',
  'matching|order.book|exchange|feed|tape|itch|oup': 'exchange-protocols',
  'market|making|arbitrage|stat.arb|mm': 'trading',
  'backtest|simulat|replay|hist': 'backtesting',
  'risk|var|drawdown|sharpe|alpha|beta': 'risk-metrics',
  'latency|throughput|p50|p99|p999|percentile': 'performance',
  'monitor|grafana|prometheus|alert|metric': 'monitoring',
  'test|mock|fake|chaos|load|stress|benchmark': 'testing',
  'deploy|ci|cd|canary|blue.green|pipeline': 'deployment',
  'recover|failover|circuit.breaker|degrade|backup|dr': 'recovery',
  'kernel|futex|epoll|io.uring|aio|sched|affinity': 'system-programming',
  'ipc|pipe|fifo|shm|mmap|socket|unix': 'ipc',
  'proto|fix|binary|itch|oup|moldudp|pcap': 'protocols',
  'math|stat|prob|distrib|regress|correl': 'mathematics',
  'time|series|signal|fft|wavelet|kalman': 'time-series',
  'ml|machine|learning|neural|tree|boost|forest': 'machine-learning',
  'order|type|limit|market|pegged|iceberg|fok|ioc': 'order-types',
  'execution|alg|vwap|twap|implementation.shortfall': 'execution-algorithms',
  'dark|pool|lit|ecn|ats|alternative': 'dark-pools',
  'auction|open|close|call|continuous': 'auctions',
  'queue|position|priority|pro.rata|fifo': 'queue-dynamics',
  'spread|liquid|depth|imbalance|toxicity': 'liquidity',
  'regul|comply|miFID|sec|finra|market.access|risk.rule': 'regulation',
  'data|pipeline|etl|kafka|stream|parquet|column|lake': 'data-engineering',
  'monte|carlo|simul|walk.forward|overfit': 'simulation',
  'p4|tofino|switch|asic|programmable': 'programmable-networking',
  'clock|ptp|sync|timestamp|nanosecond': 'clock-synchronization',
};

function buildTags(id, phase, existingTags) {
  const searchText = id.toLowerCase().replace(/-/g, ' ');
  const tags = [...(Array.isArray(existingTags) ? existingTags : [])];
  for (const [patterns, tag] of Object.entries(TAG_MAP)) {
    const parts = patterns.split('|');
    for (const p of parts) {
      if (p.length < 3) continue; // skip very short patterns to avoid false positives
      const re = new RegExp('\\b' + p.replace(/\./g, '\\W*').replace(/\*/g, '.*') + '\\b', 'i');
      if (re.test(searchText)) { tags.push(tag); break; }
    }
  }
  if (tags.length === 0) tags.push(`phase-${phase}`);
  return [...new Set(tags)].sort();
}

function extractSections(md) {
  const sections = [];
  const h2Re = /^##\s+(.+)$/gm;
  let match;
  while ((match = h2Re.exec(md)) !== null) {
    const title = match[1].trim();
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    sections.push({ id, title });
  }
  return sections;
}

if (!existsSync(CONTENT_DIR)) mkdirSync(CONTENT_DIR, { recursive: true });
if (!existsSync(JS_DIR)) mkdirSync(JS_DIR, { recursive: true });
if (!existsSync(CONCEPTS_DIR)) { console.log('No concepts directory.'); process.exit(0); }

const conceptEntries = scanConcepts();
console.error(`Found ${conceptEntries.length} concept files`);

if (conceptEntries.length === 0) process.exit(0);

console.error('Starting processing...');

const routeMap = {};
const routeList = [];
const searchIndex = [];
const contentFiles = [];

for (const entry of conceptEntries) {
  const data = parseConceptFile(entry.filePath);
  const tags = buildTags(data.id, data.phase, data.tags);
  const contentHtml = renderMarkdown(data.body, data.language);
  const sections = extractSections(data.body);
  const title = data.title;
  const hash = '#' + data.id;
  const contentPath = `content/${data.id}.json`;
  let description = (data.description || '').replace(/https?:\/\/[^\s]+/g, '').replace(/ZHFT_\w+/g, '');
  // If description is truncated (no terminal punctuation), derive from first body paragraph
  if (!description || (!/[.!?]\s*$/.test(description) && description.length < 100)) {
    const firstLine = data.body.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('```'));
    if (firstLine) description = firstLine.trim().replace(/^-\s*/, '').replace(/ZHFT_\w+/g, '').substring(0, 200);
  }
  description = description.substring(0, 200).replace(/ZHFT_\w+/g, '');

  const contentItem = { id: data.id, title, phase: data.phase, phaseName: data.phaseName, category: data.category || data.phaseName, subcategory: data.subcategory || data.phaseName, language: data.language, description: description.substring(0, 300), content: contentHtml, sections, tags, type: data.type, toc: false };
  writeFileSync(join(PROJECT_ROOT, contentPath), JSON.stringify(contentItem, null, 2));
  contentFiles.push(data.id);
  routeMap[hash] = contentPath;
  routeList.push({ hash, key: data.id, title, phase: data.phase, phaseName: data.phaseName, sections });
  const sectionTitles = sections.map(s => s.title);
  searchIndex.push({ title, phase: data.phase, phaseName: data.phaseName, category: data.category || data.phaseName, url: 'docs.html' + hash, tags, description: description.substring(0, 160), sections: sectionTitles, sectionsText: sectionTitles.join(' | ') });
}

// ============================================================
// Generate study plan from phase data
// ============================================================
const studyWeeks = [
  { week: 1, phase: 1, title: 'Foundations', topics: ['CPU Architecture', 'Memory Hierarchy', 'Cache Coherency', 'NUMA', 'RDTSC & Timing', 'Compiler Intrinsics', 'Branch Prediction', 'SIMD Basics', 'Linux Tuning', 'BIOS Tuning', 'Server Selection', 'Colo Setup'] },
  { week: 2, phase: 2, title: 'Mathematics & Statistics', topics: ['Probability Distributions', 'Time Series Analysis', 'Kalman Filters', 'Signal Processing', 'Machine Learning Basics', 'Stochastic Calculus', 'Optimization Theory'] },
  { week: 3, phase: 3, title: 'C++ Low-Latency Patterns', topics: ['Lock-Free Queues', 'Wait-Free Hazard Pointers', 'Memory Pool Allocators', 'Atomic Operations', 'Cache-Friendly Data Structures', 'Placement New', 'SIMD Intrinsics'] },
  { week: 4, phase: 4, title: 'System Programming & IPC', topics: ['Shared Memory', 'FlatBuffers', 'SBE', 'Binary Logging', 'Binary Size Optimization', 'Build Systems', 'Cross Compilation'] },
  { week: 5, phase: 5, title: 'Kernel Bypass & Protocols', topics: ['Kernel Bypass (DPDK/Onload)', 'FIX Protocol', 'ITCH/OUCH', 'TCP Tuning', 'UDP Multicast', 'Multicast Deep Dive', 'SIMD Parser'] },
  { week: 6, phase: 6, title: 'Network Hardware', topics: ['NIC Tuning', 'Switch Topology', 'Switch Configuration', 'Packet Capture', 'Cross-DC Connectivity', 'IPMI/OOB', 'Cabling Physics'] },
  { week: 7, phase: 7, title: 'Order Entry & Execution', topics: ['Order Types', 'FIX Engine', 'OMS', 'Smart Order Router', 'Risk Checks', 'Latency Measurement', 'Exchange Connectivity', 'Auction Handling', 'Configuration Management'] },
  { week: 8, phase: 8, title: 'Exchange Architecture', topics: ['Matching Engine', 'CME iLink3', 'Eurex T7', 'LSE Millennium', 'ICE Binary', 'Exchange Compare', 'Session Recovery', 'Fee Structures', 'MM Programs', 'Exchange Outages'] },
  { week: 9, phase: 9, title: 'Order Book & Microstructure', topics: ['LOB Design', 'Feed Handler', 'Top of Book', 'Book Imbalance', 'Market Data Vendors', 'Fee Dynamics', 'Gap Recovery', 'Anomaly Detection', 'Microstructure Edge'] },
  { week: 10, phase: 10, title: 'Trading Strategies', topics: ['Market Making', 'Arbitrage', 'Pairs Trading', 'Momentum', 'Optimal Execution', 'Position Management', 'Strategy Matrix'] },
  { week: 11, phase: 11, title: 'Backtesting & Simulation', topics: ['Backtest Engine', 'Market Replay', 'Latency Simulation', 'Case Simulation', 'Cross-Asset BT', 'Performance Attribution', 'Overfitting Prevention'] },
  { week: 12, phase: 12, title: 'Data Engineering', topics: ['Real-time Pipelines', 'Historical Data', 'Compression', 'KDB+', 'Alternative Data', 'Reference Data', 'Backfill Strategies', 'Modern Databases'] },
  { week: 13, phase: 13, title: 'FPGA & Hardware', topics: ['FPGA Intro', 'FPGA Parser', 'FPGA Order Gen', 'FPGA Vendors', 'FPGA vs CPU'] },
  { week: 14, phase: 14, title: 'Monitoring & Security', topics: ['Grafana', 'Latency Histograms', 'Order Tracking', 'SLI/SLO', 'Structured Logging', 'Market Data Quality', 'Secrets Management', 'Supply Chain Security'] },
  { week: 15, phase: 15, title: 'Testing & Production', topics: ['Deterministic Testing', 'Replay Testing', 'Chaos Engineering', 'Canary Release', 'Container HFT', 'DR/Failover', 'Disaster Scenarios', 'Incident Cases', 'Colocation', 'Operations', 'Compliance Testing', 'Post-Trade', 'Practical SysAdmin'] },
  { week: 16, phase: 16, title: 'Economics & Career', topics: ['Compensation & Org', 'LLM for HFT', 'Latency Cost', 'Colo Budget', 'Vendor Evaluation', 'Legal & Compliance', 'Staff+ Engineering'] },
  { week: 17, phase: 17, title: 'Failure Modes & Recovery', topics: ['Split Brain', 'Clock Anomalies', 'Phantom Orders', 'Order Duplication', 'Partial Fills', 'Sequence Resets', 'Mass Cancel', 'Stale State'] },
];

const studySections = studyWeeks.map(w => ({
  id: `week-${w.week}`,
  title: `Week ${w.week}: ${w.title}`,
}));

const contentParts = [];
contentParts.push('<h2 id="section-overview">Roadmap Overview</h2>');
contentParts.push('<div class="text-slate-600 dark:text-slate-400 text-sm leading-relaxed mb-6">A 17-week structured curriculum to build production-grade HFT engineering knowledge, from CPU architecture through failure-mode recovery.</div>');

contentParts.push('<div class="vtimeline">');
const milestoneWeeks = new Set([1, 6, 9, 11, 13, 17]);
for (const w of studyWeeks) {
  const colorIdx = ((w.week - 1) % 6) + 1;
  contentParts.push(`<div class="vtimeline-entry">`);
  contentParts.push(`<div class="vtimeline-dot w${colorIdx}"></div>`);
  contentParts.push(`<div class="vtimeline-header">`);
  contentParts.push(`<span class="vtimeline-week w${colorIdx}">W${w.week}</span>`);
  contentParts.push(`<span class="vtimeline-title">${w.title}</span>`);
  contentParts.push(`<span class="vtimeline-phase">Phase ${w.phase}</span>`);
  contentParts.push('</div>');
  contentParts.push('<div class="vtimeline-topics">');
  for (const topic of w.topics) {
    contentParts.push(`<span class="vtimeline-topic">${topic}</span>`);
  }
  contentParts.push('</div>');
  if (milestoneWeeks.has(w.week)) {
    const msgs = {
      1: 'Phase 1 complete — core hardware & OS foundations',
      6: 'Phases 1-6 complete — systems & networking fundamentals',
      9: 'Phases 1-9 complete — exchange protocols & market structure',
      11: 'Phases 1-11 complete — backtesting & simulation ready',
      13: 'Phases 1-13 complete — FPGA & hardware acceleration',
      17: 'Full curriculum complete — production-ready HFT engineer',
    };
    contentParts.push(`<div class="vtimeline-milestone">🏁 ${msgs[w.week]}</div>`);
  }
  contentParts.push('</div>');
}
contentParts.push('</div>');

const studyContentHtml = contentParts.join('\n');

const studyPlanContentItem = {
  id: 'study-plan',
  title: 'HFT Study Plan',
  phase: 0,
  phaseName: 'Study Plan',
  category: 'Study Plan',
  subcategory: 'Study Plan',
  language: 'markdown',
  description: 'A 17-week structured curriculum covering all HFT engineering domains: CPU architecture, low-latency C++, kernel bypass, exchange protocols, trading strategies, and production operations.',
  content: studyContentHtml,
  sections: studySections,
  tags: ['study-plan', 'curriculum', 'learning-path'],
  type: 'study-plan',
  toc: true,
};

writeFileSync(join(PROJECT_ROOT, 'content', 'study-plan.json'), JSON.stringify(studyPlanContentItem, null, 2));
routeMap['#study-plan'] = 'content/study-plan.json';
routeList.push({ hash: '#study-plan', key: 'study-plan', title: 'HFT Study Plan', phase: 0, phaseName: 'Study Plan', sections: studySections });
searchIndex.push({ title: 'HFT Study Plan', phase: 0, phaseName: 'Study Plan', category: 'Study Plan', url: 'docs.html#study-plan', tags: ['study-plan'], description: 'A 17-week structured curriculum covering all HFT engineering domains.', sections: studySections.map(s => s.title), sectionsText: studySections.map(s => s.title).join(' | ') });
contentFiles.push('study-plan');
console.error('Generated study plan');

const generatedJs = `// Auto-generated by scripts/build.mjs
window.__BUILD_TIMESTAMP = "${new Date().toISOString()}";
window.__ROUTE_MAP = ${JSON.stringify(routeMap, null, 2)};
window.__ROUTES = ${JSON.stringify(routeList, null, 2)};
window.__SEARCH_INDEX = ${JSON.stringify(searchIndex, null, 2)};
`;
writeFileSync(join(JS_DIR, 'generated.js'), generatedJs);
console.error(`\nRoutes: ${Object.keys(routeMap).length}, Search: ${searchIndex.length}, Files: ${contentFiles.length}`);
