#!/usr/bin/env node
/**
 * Generate machine-readable canonical catalogues from the R4 specification.
 *
 * SPEC: 30 CAT-1..CAT-5. `30_CANONICAL_CATALOGUES.md` is the sole authoritative
 * source for the membership and cardinality of every catalogue. This script is the
 * ONE authorized migration path from that document into runtime definitions, so no
 * enumeration is ever hand-copied into a module (30 CAT-2, SC-POL-004).
 *
 * Run: npm run catalogues
 * Output: src/catalogue/generated/catalogues.json  (checked in; regenerate on spec change)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const SPEC = join(repoRoot, 'docs', 'serva-code', '30_CANONICAL_CATALOGUES.md');
const OUT_DIR = join(repoRoot, 'src', 'catalogue', 'generated');
const OUT = join(OUT_DIR, 'catalogues.json');

const md = readFileSync(SPEC, 'utf8');

/*
 * Profiles are canonical in 03 §7 and appear nowhere in 30, so they are read from their
 * own document rather than copied into this script. A profile that exists only in a
 * generator is a second company model, which Phase 5 is explicitly forbidden to create.
 */
const LIFECYCLE = join(repoRoot, 'docs', 'serva-code', '03_PROJECT_LIFECYCLE.md');
const lifecycleMd = readFileSync(LIFECYCLE, 'utf8');

/** Slice the document between two headings. */
function section(startsWith, endsWith) {
  const a = md.indexOf(startsWith);
  const b = md.indexOf(endsWith);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`Cannot locate section ${startsWith} .. ${endsWith} in ${SPEC}`);
  }
  return md.slice(a, b);
}

/** Parse markdown table rows whose first cell matches `idPattern`. */
function rows(seg, idPattern) {
  const out = [];
  for (const line of seg.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim().replace(/^`|`$/g, ''));
    const id = cells[0];
    if (id === undefined || !idPattern.test(id)) continue;
    out.push(cells);
  }
  return out;
}

const deptSeg = section('## 3. Department Catalogue', '## 4. Agent Catalogue');
const agentSeg = section('## 4. Agent Catalogue', '### 4.1');
const rtcSeg = section('## 5. Runtime Checker', '## 6. Lifecycle Stage Catalogue');
const stageSeg = section('## 6. Lifecycle Stage Catalogue', '## 7. Quality Gate Catalogue');
const gateSeg = section('## 7. Quality Gate Catalogue', '## 8. Workflow Catalogue');
const wfSeg = section('## 8. Workflow Catalogue', '## 9. Policy Catalogue');

const departments = rows(deptSeg, /^SC-DEPT-\d+$/).map(([id, name, tier]) => ({
  id,
  name,
  tier: Number.parseInt(tier, 10),
}));

const agents = rows(agentSeg, /^SC-AGENT-\d+$/).map(
  ([id, name, dept, archetype, authority, ceiling]) => ({
    id,
    name,
    departmentId: `SC-DEPT-${dept}`,
    archetype,
    authority,
    magnitudeCeiling: (ceiling.match(/M[0-4]/) ?? ['M2'])[0],
  }),
);

const runtimeComponents = rows(rtcSeg, /^SC-RTC-\d+$/).map(([id, name, kind]) => ({
  id,
  name,
  kind,
}));

const stages = rows(stageSeg, /^SC-STAGE-\d+$/).map(([id, name, phase, owner, gate]) => ({
  id,
  name,
  phase,
  ownerDepartmentId: /^\d+$/.test(owner) ? `SC-DEPT-${owner}` : owner,
  gate: gate === 'NONE (continuous)' ? null : gate,
}));

const gates = rows(gateSeg, /^SC-GATE-[A-Z_]+$/).map(([id, afterStage, blocking]) => ({
  id,
  afterStage,
  blocking: blocking.toLowerCase().startsWith('yes'),
}));

const workflows = rows(wfSeg, /^SC-WF-\d+$/).map(([id, name]) => ({ id, name }));

/* ------------------------------------------------------------------ profiles (03 §7) */

/** Stage numbers that actually exist, so a range expands to real stages only. */
const stageNumbers = stages.map((st) => st.id.replace('SC-STAGE-', ''));

/**
 * Parse one cell of the "Stages executed" column.
 *
 * The column is written for people: `010–016(delta)`, `030(light)`, `054 (+ fix path
 * afterwards)`, `All applicable`. Anything this cannot parse is preserved verbatim in
 * `unparsed` rather than dropped, because silently losing a stage from a profile would
 * silently remove a gate from a project.
 */
function parseStageSelection(cell) {
  const text = cell.replace(/\*\*/g, '').trim();
  if (/^all applicable$/i.test(text)) {
    return { all: true, stages: stageNumbers.map((n) => ({ stage: n })), unparsed: [] };
  }
  const out = [];
  const unparsed = [];
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    // `NNN–NNN(mode)` or `NNN-NNN(mode)`
    const range = /^(\d{3})\s*[–-]\s*(\d{3})\s*(?:\(([^)]*)\))?/.exec(part);
    if (range !== null) {
      const [, from, to, mode] = range;
      for (const n of stageNumbers) {
        if (n >= from && n <= to) out.push(mode === undefined ? { stage: n } : { stage: n, mode });
      }
      continue;
    }
    // `NNN(mode)` or `NNN`
    const one = /^(\d{3})\s*(?:\(([^)]*)\))?(.*)$/.exec(part);
    if (one !== null) {
      const [, n, mode, rest] = one;
      if (!stageNumbers.includes(n)) {
        unparsed.push(part);
        continue;
      }
      out.push(mode === undefined ? { stage: n } : { stage: n, mode });
      // Trailing prose is REPORTED, not dropped. `013 or targeted research` carries a
      // real alternative, and a parser that quietly keeps the number and discards the
      // sentence is how a profile comes to mean less than the spec says.
      if ((rest ?? '').trim() !== '') unparsed.push(part);
      continue;
    }
    unparsed.push(part);
  }
  return { all: false, stages: out, unparsed };
}

const profileSeg = (() => {
  const a = lifecycleMd.indexOf('## 7. Lifecycle Profiles');
  const b = lifecycleMd.indexOf('### 7.1');
  if (a < 0 || b < 0 || b <= a) throw new Error('Cannot locate the profile table in 03 §7.');
  return lifecycleMd.slice(a, b);
})();

const profiles = [];
for (const line of profileSeg.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim().replace(/^`|`$/g, ''));
  const id = cells[0];
  if (id === undefined || !/^PRF-[A-Z-]+$/.test(id)) continue;
  const [, appliesTo, stagesCell, notes] = cells;
  const parsed = parseStageSelection(stagesCell ?? '');
  profiles.push({
    id,
    appliesTo,
    allApplicable: parsed.all,
    stages: parsed.stages,
    unparsedStageTerms: parsed.unparsed,
    stagesRaw: stagesCell,
    notes,
  });
}

// Policies: the constitution owns the text; 30 §9 owns membership. Derive the
// identifier set from 01 headings so a policy cannot exist without a definition.
const constitution = readFileSync(
  join(repoRoot, 'docs', 'serva-code', '01_COMPANY_CONSTITUTION.md'),
  'utf8',
);
const policies = [...constitution.matchAll(/^### (SC-POL-\d{3}) — (.+)$/gm)].map((m) => ({
  id: m[1],
  name: m[2].trim(),
}));

const specDigest = createHash('sha256').update(md, 'utf8').digest('hex');

const payload = {
  $generated: {
    by: 'scripts/generate-catalogues.mjs',
    from: 'docs/serva-code/30_CANONICAL_CATALOGUES.md',
    specDigest,
    note: 'GENERATED — do not edit. Regenerate with `npm run catalogues` when the R4 specification changes (30 CAT-2b).',
  },
  departments,
  agents,
  runtimeComponents,
  stages,
  gates,
  workflows,
  profiles,
  policies,
  counts: {
    departments: departments.length,
    agents: agents.length,
    runtimeComponents: runtimeComponents.length,
    stages: stages.length,
    gates: gates.length,
    workflows: workflows.length,
    profiles: profiles.length,
    policies: policies.length,
  },
};

for (const [k, v] of Object.entries(payload.counts)) {
  if (v === 0) throw new Error(`Catalogue "${k}" parsed as empty — the spec format changed.`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('Generated ' + OUT);
for (const [k, v] of Object.entries(payload.counts)) console.log('  ' + k.padEnd(20) + v);
console.log('  specDigest           ' + specDigest.slice(0, 16) + '...');
