#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CONCEPTS_DIR = join(PROJECT_ROOT, 'concepts');

let fixedCount = 0;
let fixedFiles = [];

function scanConcepts(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'index.md' || entry === 'log.md') continue;
    if (statSync(full).isDirectory()) {
      results.push(...scanConcepts(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function fixFile(filePath) {
  let content = readFileSync(filePath, 'utf8');
  let original = content;
  let changes = [];

  // --- Fix 1: Wrap comment-only Usage sections in bash code fences ---
  const commentSlashSlash = String.raw`\s*//[^\n]*\n`;
  const usageWithComments = new RegExp(
    String.raw`^(## Usage)\n((?:` + commentSlashSlash + `)+)`, 'gm'
  );
  content = content.replace(usageWithComments, (match, heading, commentBlock) => {
    const lines = commentBlock.trimEnd().split('\n');
    const codeLines = lines.map(line => {
      let l = line.trimStart();
      if (l.startsWith('// ')) l = l.slice(3);
      else if (l.startsWith('//')) l = l.slice(2);
      return l;
    });
    changes.push('wrapped Usage comments in bash fence');
    return heading + '\n\n```bash\n' + codeLines.join('\n') + '\n```\n';
  });

  // --- Fix 2: Fix broken comment blocks in Source Code sections ---
  const brokenComment = new RegExp(
    String.raw`(` + '```cpp' + String.raw`\n)((?:\*\s[^\n]*\n)+)`, 'gm'
  );
  content = content.replace(brokenComment, (match, fence, commentBlock) => {
    if (commentBlock.trimStart().startsWith('/*')) return match;
    const lines = commentBlock.split('\n');
    let fixed = '/*\n';
    for (const line of lines) {
      let l = line.replace(/^\s*\*\s?/, ' * ');
      if (l.trim() === '*') l = ' *';
      fixed += l + '\n';
    }
    fixed += ' */\n';
    changes.push('fixed broken comment block');
    return fence + fixed;
  });

  // --- Fix 3: Remove triple+ blank lines ---
  content = content.replace(/\n{3,}/g, '\n\n');

  // --- Fix 4: Fix broken RNG seeding bullet in deterministic-test.md ---
  content = content.replace(
    /- \*\*RNG seeding in tests\*\*: every source of randomness \(`\n\n\s+rd = rand\(\)`/g,
    '- **RNG seeding in tests**: every source of randomness (`rd = rand()`'
  );

  // --- Fix 5: Fix missing blank line between closing fence and next heading ---
  content = content.replace(/```\n(##)/g, '```\n\n$1');

  // --- Fix 6: Remove trailing blank lines after closing code fences ---
  // Matches ``` followed by whitespace-only lines at end of file or before next section
  content = content.replace(/```\n\s*$/gm, '```\n');

  // --- Fix 7: Remove trailing blank lines at end of file ---
  content = content.replace(/\n\s*$/, '\n');

  if (content !== original) {
    writeFileSync(filePath, content, 'utf8');
    fixedCount++;
    fixedFiles.push(relative(PROJECT_ROOT, filePath));
  }
}

const files = scanConcepts(CONCEPTS_DIR);
console.log(`Found ${files.length} concept files`);

for (const f of files) {
  fixFile(f);
}

console.log(`Fixed ${fixedCount} files:`);
fixedFiles.forEach(f => console.log(`  ${f}`));
