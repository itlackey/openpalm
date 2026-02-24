#!/usr/bin/env node

/**
 * Rebuilds community/index.json from individual YAML snippet files.
 * 
 * Discovers all .yaml/.yml files in community/{channels,services,automations}/
 * directories, validates them, and generates a combined index.json.
 */

const fs = require('fs');
const path = require('path');

// Try to require js-yaml, fallback to Bun.YAML when available
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  if (typeof Bun !== 'undefined' && Bun.YAML && typeof Bun.YAML.parse === 'function') {
    yaml = {
      load: (content) => Bun.YAML.parse(content)
    };
  } else {
    console.error('js-yaml not found. Install it or run this script with Bun.');
    process.exit(1);
  }
}

const COMMUNITY_DIR = path.join(process.cwd(), 'community');
const INDEX_FILE = path.join(COMMUNITY_DIR, 'index.json');
const SUBDIRS = ['channels', 'services', 'automations'];

console.log('🔍 Scanning for community snippets...\n');

const snippets = [];
let errors = 0;

// Scan each subdirectory
for (const subdir of SUBDIRS) {
  const subdirPath = path.join(COMMUNITY_DIR, subdir);
  
  // Skip if directory doesn't exist
  if (!fs.existsSync(subdirPath)) {
    console.log(`⊘ Directory not found: community/${subdir}/`);
    continue;
  }

  const files = fs.readdirSync(subdirPath)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (files.length === 0) {
    console.log(`⊘ No snippets in community/${subdir}/`);
    continue;
  }

  console.log(`\n📂 community/${subdir}/:`);

  for (const file of files) {
    const filePath = path.join(subdirPath, file);
    const relativePath = `community/${subdir}/${file}`;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const snippet = yaml.load(content);

      if (!snippet) {
        console.log(`  ✗ ${file} — empty file`);
        errors++;
        continue;
      }

      // Validate required fields
      const missingFields = [];
      for (const field of ['kind', 'name', 'env']) {
        if (!snippet[field]) {
          missingFields.push(field);
        }
      }

      if (missingFields.length > 0) {
        console.log(`  ✗ ${file} — missing fields: ${missingFields.join(', ')}`);
        errors++;
        continue;
      }

      // Validate kind
      if (!['channel', 'service', 'automation'].includes(snippet.kind)) {
        console.log(`  ✗ ${file} — invalid kind: ${snippet.kind}`);
        errors++;
        continue;
      }

      // Validate env array
      if (!Array.isArray(snippet.env)) {
        console.log(`  ✗ ${file} — env must be an array`);
        errors++;
        continue;
      }

      // Validate env entries
      for (let i = 0; i < snippet.env.length; i++) {
        const env = snippet.env[i];
        if (!env.name || typeof env.required !== 'boolean') {
          console.log(`  ✗ ${file} — env[${i}] missing required fields (name, required)`);
          errors++;
          continue;
        }
        if (!/^[A-Z][A-Z0-9_]*$/.test(env.name)) {
          console.log(`  ✗ ${file} — env[${i}] name '${env.name}' must be UPPER_CASE`);
          errors++;
          continue;
        }
      }

      snippets.push({
        ...snippet,
        _source: relativePath
      });

      console.log(`  ✓ ${file} (${snippet.kind}: ${snippet.name})`);
    } catch (err) {
      console.log(`  ✗ ${file} — ${err instanceof Error ? err.message : String(err)}`);
      errors++;
    }
  }
}

console.log('\n');

if (errors > 0) {
  console.error(`❌ Found ${errors} error(s). Aborting.`);
  process.exit(1);
}

// Check for duplicate names
const names = new Map();
for (const snippet of snippets) {
  if (names.has(snippet.name)) {
    console.error(`❌ Duplicate snippet name: "${snippet.name}" (in ${snippet._source} and ${names.get(snippet.name)})`);
    process.exit(1);
  }
  names.set(snippet.name, snippet._source);
}

// Write index
try {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(snippets, null, 2) + '\n', 'utf8');
  console.log(`✅ Generated ${INDEX_FILE}`);
  console.log(`   Contains ${snippets.length} snippet(s):\n`);
  
  const byKind = {};
  for (const s of snippets) {
    byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    console.log(`   • ${s.kind}: ${s.name}`);
  }
  
  console.log('\n   Summary by kind:');
  for (const [kind, count] of Object.entries(byKind)) {
    console.log(`   • ${kind}: ${count}`);
  }
  console.log('');
} catch (err) {
  console.error(`❌ Failed to write index: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
