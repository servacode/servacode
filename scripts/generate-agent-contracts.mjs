#!/usr/bin/env node
/**
 * Generate the machine-readable AgentContract registry from the R4 specification.
 *
 * SPEC: 32 (the authoritative contract catalogue), 32 §8 (resolution model),
 * 05 §2 (the 29-field schema), 30 §4 (canonical membership).
 *
 * This script is the ONE authorized migration path from `32_AGENT_CONTRACT_CATALOG.md`
 * into runtime definitions. 55 contracts are never hand-copied into TypeScript
 * (30 CAT-2, SC-POL-004, SC-POL-025): a second copy is a second source of truth, and
 * the two would diverge on the first spec amendment.
 *
 * Every one of the 29 schema fields is emitted with its RESOLUTION KIND alongside its
 * value, so "every contract resolves every field" is checkable rather than asserted
 * (32 §8.1). A field that cannot resolve fails the build here, not at runtime.
 *
 * Run: npm run contracts
 * Output: src/agents/generated/contracts.json  (checked in; regenerate on spec change)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const SPEC = join(repoRoot, 'docs', 'serva-code', '32_AGENT_CONTRACT_CATALOG.md');
const CATALOGUES = join(repoRoot, 'src', 'catalogue', 'generated', 'catalogues.json');
const OUT_DIR = join(repoRoot, 'src', 'agents', 'generated');
const OUT = join(OUT_DIR, 'contracts.json');

const md = readFileSync(SPEC, 'utf8');
const catalogues = JSON.parse(readFileSync(CATALOGUES, 'utf8'));

/** The middot separator 32 uses inside a bullet, written as an escape so this file stays ASCII. */
const MIDDOT = String.fromCharCode(0xb7);
/**
 * 32 separates fields inside a bullet with a middot. `labelled` trims each segment,
 * so the trailing separator may have lost its space -- split on the character with
 * optional surrounding whitespace rather than on a fixed three-character string.
 */
const SEP_RE = new RegExp('\s*' + MIDDOT + '\s*');
const SEP_ALL = new RegExp('\s*' + MIDDOT + '\s*', 'g');

const problems = [];
const fatal = (msg) => problems.push(msg);

/* ------------------------------------------------------------------ helpers */

/** Strip markdown emphasis and code ticks from a value, keeping the text. */
function clean(s) {
  return s
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(new RegExp('[' + String.fromCharCode(0xb7) + '-]\s*$'), '')
    .replace(/\s*-\s*$/, '')
    .replace(/[.;]$/, '')
    .trim();
}

/** Split a semicolon/comma list into trimmed non-empty parts. */
function list(s, sep = /;/) {
  if (s === undefined) return [];
  return clean(s)
    .split(sep)
    .map((p) =>
      p
        .trim()
        .replace(/^[,.]|[,.]$/g, '')
        .trim(),
    )
    .filter((p) => p.length > 0);
}

/**
 * Split one contract bullet into its `**Label:**` segments.
 *
 * Several labels share a line ("Proposals: … Reviews: … CoI: … Budget: …"), so the
 * unit of parsing is the label, not the line.
 */
function labelled(text) {
  const out = new Map();
  const re = /\*\*([A-Za-z][^*:\n]*?):\*\*/g;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null)
    hits.push({ label: m[1].trim(), start: m.index, end: re.lastIndex });
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const stop = i + 1 < hits.length ? hits[i + 1].start : text.length;
    out.set(h.label.toLowerCase(), text.slice(h.end, stop).trim());
  }
  return out;
}

/* -------------------------------------------------- inheritance blocks (§2-§4) */

function blockBody(name, seg) {
  const i = seg.indexOf('### `' + name + '`');
  if (i < 0) return undefined;
  const rest = seg.slice(i);
  const j = rest.indexOf('\n### ', 3);
  return j < 0 ? rest : rest.slice(0, j);
}

const universalSeg = md.slice(md.indexOf('## 2. `A-ALL`'), md.indexOf('## 3. Archetype'));
const archetypeSeg = md.slice(md.indexOf('## 3. Archetype'), md.indexOf('## 5.'));

const universal = labelled(universalSeg);
/** A-ALL supplies these to every contract verbatim (32 §2). */
const A_ALL = {
  refusalSurface: list(
    universal.get('refusal surface (inherited, non-overridable — `05` §8.1)') ?? '',
  ),
  forbiddenActions: list(universal.get('forbidden actions (inherited)') ?? ''),
  escalationConditions: list(universal.get('escalation conditions (inherited)') ?? ''),
  failureConditions: list(universal.get('failure conditions (inherited)') ?? ''),
  proposalBehavior: clean(universal.get('proposal behavior (inherited)') ?? ''),
  untrustedContentRule: clean(
    universal.get('untrusted-content behavior (inherited, `sc-pol-027`)') ??
      universal.get('untrusted-content behavior (inherited, `SC-POL-027`)'.toLowerCase()) ??
      '',
  ),
  networkScopeDefault: 'NONE',
};
for (const [k, v] of Object.entries(A_ALL)) {
  if (Array.isArray(v) ? v.length === 0 : String(v).length === 0) {
    fatal('A-ALL inheritance block field "' + k + '" did not resolve from 32 §2');
  }
}

const ARCHETYPES = [
  'A-GOVERNOR',
  'A-ANALYST',
  'A-DEFINER',
  'A-ARCHITECT',
  'A-PRODUCER',
  'A-VERIFIER',
];
const archetypeBlocks = {};
for (const name of ARCHETYPES) {
  const body = blockBody(name, archetypeSeg);
  if (body === undefined) {
    fatal('Archetype inheritance block ' + name + ' is absent from 32 §3');
    continue;
  }
  const f = labelled(body);
  archetypeBlocks[name] = {
    nonResponsibilities: list(f.get('non-responsibilities') ?? ''),
    outputs: clean(f.get('outputs') ?? ''),
    qualityCriteria: list(f.get('quality criteria') ?? ''),
    /*
     * 32 §8.2 row 26 says review_responsibilities is "INHERITED(A-<ARCHETYPE>); LOCAL
     * for verifiers -- A-VERIFIER defines the obligation". A-VERIFIER states the
     * obligation under "Required output (additional)" rather than under a
     * "Review responsibilities" heading, and no verifier block carries a Reviews line.
     * The obligation is taken from where the block actually states it. (SF-3)
     */
    reviewResponsibilities: clean(
      f.get('review responsibilities') ?? f.get('required output (additional)') ?? '',
    ),
    additionalForbidden: list(f.get('additional forbidden') ?? ''),
    additionalEscalations: list(f.get('additional escalations') ?? ''),
  };
  // 32 §8.2 row 26: review_responsibilities is INHERITED(A-<ARCHETYPE>) except for
  // verifiers, which state it LOCAL. A-VERIFIER therefore has no block-level value.
  const required =
    name === 'A-VERIFIER'
      ? ['nonResponsibilities', 'qualityCriteria']
      : ['nonResponsibilities', 'qualityCriteria', 'reviewResponsibilities'];
  for (const k of required) {
    const v = archetypeBlocks[name][k];
    if (Array.isArray(v) ? v.length === 0 : v.length === 0) {
      fatal(name + ' block does not resolve "' + k + '" (32 §3)');
    }
  }
}

/* ------------------------------------------------------ tier blocks (§4) */

const tierSeg = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'));
const tierBlocks = {};
for (const m of tierSeg.matchAll(/### `(T-[A-Z]+)`/g)) {
  const body = blockBody(m[1], tierSeg);
  const f = labelled(body ?? '');
  tierBlocks[m[1]] = {
    tools: clean(f.get('tools') ?? ''),
    filesystemScope: clean(f.get('fs') ?? f.get('filesystem scope') ?? ''),
    requiredEvidence: list(f.get('required evidence') ?? ''),
  };
}

/* ------------------------------------------------ CoI pairs (§6, rule R-COI) */

const coiSeg = md.slice(
  md.indexOf('## 6. Conflict-of-Interest'),
  md.indexOf('## 7. Contract Validation'),
);
const coiPairs = [];
for (const line of coiSeg.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => clean(c));
  // clean() now strips a trailing dash run, so a markdown separator row reduces to
  // empty cells rather than to '---'. Reject on emptiness, which covers both forms.
  if (cells.length < 3 || cells[0] === 'A' || cells[0].length === 0 || cells[0] === '-') continue;
  coiPairs.push({ a: cells[0], b: cells[1], basis: cells[2] });
}
if (coiPairs.length === 0) fatal('No conflict-of-interest pairs parsed from 32 §6');

/** Expand a CoI cell into concrete agent ids where it names them. */
function agentIdsIn(cell) {
  const ids = [];
  // "SC-AGENT-050 / 051 / 052" and "SC-AGENT-133, SC-AGENT-213"
  let prefix;
  for (const tok of cell.split(/[,/]/).map((t) => t.trim())) {
    const full = tok.match(/^SC-AGENT-(\d{3})$/);
    if (full !== null) {
      prefix = 'SC-AGENT-';
      ids.push(tok);
      continue;
    }
    const bare = tok.match(/^(\d{3})$/);
    if (bare !== null && prefix !== undefined) ids.push(prefix + bare[1]);
  }
  return ids;
}

/* ---------------------------------------------- determinism (§9.2) and AET (§9.1) */

const aetSeg = md.slice(md.indexOf('### 9.1'), md.indexOf('### 9.2'));
const aetByAgent = new Map();
for (const line of aetSeg.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => clean(c));
  const id = (cells[0] ?? '').match(/SC-AGENT-\d{3}/);
  if (id === null) continue;
  aetByAgent.set(id[0], {
    criteria: (cells[1] ?? '')
      .split(',')
      .map((s) => 'AET-' + s.trim())
      .filter((s) => /^AET-\d$/.test(s)),
    justification: cells[2] ?? '',
  });
}

const detSeg = md.slice(md.indexOf('### 9.2'), md.indexOf('### 9.3'));
const determinismByArchetype = new Map();
const architectPerOutput = new Map();
for (const line of detSeg.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => clean(c));
  const arch = cells[0];
  if (ARCHETYPES.map((a) => a.slice(2)).includes(arch)) {
    const value = cells[1] ?? '';
    determinismByArchetype.set(
      arch,
      /Mixed/i.test(value) ? 'MIXED' : /JUDGMENT/.test(value) ? 'JUDGMENT' : 'GENERATIVE',
    );
  }
  const idm = arch.match(/^SC-AGENT-(\d{3})/);
  if (idm !== null) {
    architectPerOutput.set('SC-AGENT-' + idm[1], {
      generative: list(cells[1] ?? '', /,/),
      judgment: list(cells[2] ?? '', /,/),
    });
  }
}

/* ------------------------------------------------------ contract blocks (§5) */

const deptTier = new Map(catalogues.departments.map((d) => [d.id, d.tier]));
const catalogueAgents = new Map(catalogues.agents.map((a) => [a.id, a]));

/** Tier 4/5 tier-block names, used when a contract inherits its tool surface. */
function tierBlockFor(inherits) {
  return inherits.find((i) => i.startsWith('T-'));
}

const contracts = [];
const blockRe = /^#### (SC-AGENT-\d{3}) · (.+?)\s+`v([0-9.]+)`\s*$/gm;
const starts = [];
let bm;
while ((bm = blockRe.exec(md)) !== null) {
  starts.push({
    id: bm[1],
    name: bm[2].trim(),
    version: bm[3],
    at: bm.index,
    headEnd: blockRe.lastIndex,
  });
}

for (let i = 0; i < starts.length; i++) {
  const s = starts[i];
  // The last block ends at the next '## ' heading. 32's section headings are not in
  // numeric order in the file (§6 and §7 follow §9), so anchoring on '## 6.' would
  // swallow §8 and §9 into the final contract block.
  const end = i + 1 < starts.length ? starts[i + 1].at : md.indexOf('\n## ', s.at);
  const body = md.slice(s.headEnd, end < 0 ? md.length : end);
  const headerLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  const f = labelled(body);

  const dept = (headerLine.match(/SC-DEPT-\d{3}/) ?? [])[0];
  const archetype = (headerLine.match(/\*\*([A-Z]+)\*\* · \*\*/) ?? [])[1];
  const authority = (headerLine.match(/\*\* · \*\*([A-Z_]+)\*\*/) ?? [])[1];
  const ceiling = (headerLine.match(/ceiling \*\*(.+?)\*\*/) ?? [])[1];
  const inherits = [...headerLine.matchAll(/`(A-[A-Z]+|T-[A-Z]+)`/g)].map((m) => m[1]);

  const problemsFor = (msg) => fatal(s.id + ': ' + msg);
  if (dept === undefined) problemsFor('department cannot resolve from the header line');
  if (archetype === undefined) problemsFor('archetype cannot resolve from the header line');
  if (authority === undefined) problemsFor('authority_level cannot resolve from the header line');
  if (ceiling === undefined) problemsFor('magnitude_ceiling cannot resolve from the header line');
  if (inherits.length === 0) problemsFor('inherits list is empty (CR-R2)');

  const archBlockName = 'A-' + (archetype ?? '');
  const archBlock = archetypeBlocks[archBlockName];
  if (archBlock === undefined)
    problemsFor('archetype block ' + archBlockName + ' does not exist (CR-R2)');
  if (archetype !== undefined && !inherits.includes(archBlockName)) {
    problemsFor('inherits does not name ' + archBlockName + ' (CR-R2)');
  }

  const tier = dept === undefined ? undefined : deptTier.get(dept);
  if (tier === undefined)
    problemsFor('R-TIER cannot resolve: department ' + dept + ' is not in 30 §3');

  const outputsRaw = f.get('outputs') ?? '';
  const schemaRef = (outputsRaw.match(/schema\s+`(SCH-[A-Z0-9-]+)`/) ?? [])[1];
  if (schemaRef === undefined) problemsFor('output_schema_ref cannot resolve (DC-30)');

  const toolsRaw = f.get('tools');
  const tb = tierBlockFor(inherits);
  const tierBlock = tb === undefined ? undefined : tierBlocks[tb];
  const tools = toolsRaw !== undefined ? clean(toolsRaw.split(SEP_RE)[0]) : tierBlock?.tools;
  if (tools === undefined || tools.length === 0)
    problemsFor('tools cannot resolve (LOCAL or T-block)');

  /*
   * R-FS (proposed R5 amendment; see SPEC_IMPLEMENTATION_FINDINGS SF-2).
   *
   * 32 §8.2 row 16 gives filesystem_scope two resolutions -- LOCAL, or
   * INHERITED(T-PRODUCTION|T-ASSURANCE). Four contracts (110, 251, 260, 270) state no
   * FS line and inherit no tier block, so the stated rule is not total. It resolves
   * fail-closed:
   *
   *   R-FS: filesystem_scope := NONE, where neither LOCAL nor a tier block supplies it.
   *
   * NONE is the only safe default. It matches network_scope's inherited default in
   * A-ALL, which exists for exactly this reason, and an over-granted scope is a
   * capability defect while an under-granted one is a visible escalation.
   */
  const fsRaw = f.get('fs');
  const filesystemScope =
    fsRaw !== undefined ? clean(fsRaw.split(SEP_RE)[0]) : (tierBlock?.filesystemScope ?? 'NONE');
  if (filesystemScope.length === 0) problemsFor('filesystem_scope resolved to an empty value');

  const netRaw = f.get('net');
  const budgetRaw = f.get('budget');
  const budget =
    budgetRaw === undefined ? undefined : (clean(budgetRaw).match(/B-[A-Z]+/) ?? [])[0];
  if (budget === undefined) problemsFor('context_budget cannot resolve (CR-R9, DC-41)');

  const mission = clean(f.get('mission') ?? '');
  if (mission.length === 0) problemsFor('mission is absent (DC-29)');
  /*
   * R-RESP (proposed R5 amendment; see SPEC_IMPLEMENTATION_FINDINGS SF-1).
   *
   * 32 §9.3 lists `responsibilities` as a per-contract LOCAL field verified by DC-29,
   * but 13 of the 55 blocks state no `Responsibilities:` line -- they carry a
   * `Kept separate ... because:` line instead, which is the AET justification (§9.1),
   * not a responsibility set. Rather than invent responsibilities for 13 agents, the
   * field derives from one the spec does require of every contract:
   *
   *   R-RESP: responsibilities := outputs, where no Responsibilities line is stated.
   *
   * Total over 30 §4, because DC-29/DC-30 require `Outputs` on every block. An agent's
   * responsibility is to produce its declared outputs; deriving it states nothing the
   * contract did not already say.
   */
  const localResponsibilities = list(f.get('responsibilities') ?? '');
  const responsibilities =
    localResponsibilities.length > 0
      ? localResponsibilities
      : list(clean(outputsRaw.split(SEP_ALL)[0]), /,/);
  if (responsibilities.length === 0) {
    problemsFor('responsibilities cannot resolve: no Responsibilities line and no outputs (DC-29)');
  }
  const inputs = list(f.get('inputs') ?? '', /,/);
  if (inputs.length === 0) problemsFor('inputs is absent (DC-29)');

  // R-COI: named pairs bind in addition to any LOCAL statement.
  const derivedCoi = [];
  for (const p of coiPairs) {
    const as = agentIdsIn(p.a);
    const bs = agentIdsIn(p.b);
    if (as.includes(s.id)) derivedCoi.push({ with: bs.length > 0 ? bs : [p.b], basis: p.basis });
    if (bs.includes(s.id)) derivedCoi.push({ with: as.length > 0 ? as : [p.a], basis: p.basis });
  }

  const archDeterminism = determinismByArchetype.get(archetype ?? '');
  if (archDeterminism === undefined)
    problemsFor('output determinism cannot resolve for archetype ' + archetype + ' (CR-R6)');
  const perOutput = architectPerOutput.get(s.id);
  if (archDeterminism === 'MIXED' && perOutput === undefined) {
    problemsFor('archetype is MIXED but 32 §9.2 has no per-output resolution (CR-R6)');
  }

  const aet = aetByAgent.get(s.id);
  if (aet === undefined || aet.criteria.length === 0)
    problemsFor('no AET criterion in 32 §9.1 (CR-R7)');

  const localNonResp = list(f.get('non-responsibilities') ?? '');
  const localQuality = list(f.get('quality criteria') ?? '');
  const localReviews = clean(f.get('reviews') ?? '');
  const localEvidence = list(f.get('required evidence') ?? '');

  // CR-R4: a LOCAL field identical to its inherited block is boilerplate, not content.
  if (archBlock !== undefined && localNonResp.length > 0) {
    const same = JSON.stringify(localNonResp) === JSON.stringify(archBlock.nonResponsibilities);
    if (same) problemsFor('non_responsibilities restates ' + archBlockName + ' verbatim (CR-R4)');
  }

  const refusalLabel = [...f.keys()].find((k) => k.startsWith('refusal'));

  contracts.push({
    id: s.id,
    name: s.name,
    version: s.version,
    department: dept,
    tier,
    archetype,
    authorityLevel: authority,
    magnitudeCeiling: ceiling,
    mission,
    responsibilities,
    nonResponsibilities:
      localNonResp.length > 0 ? localNonResp : (archBlock?.nonResponsibilities ?? []),
    inputs,
    outputs: clean(outputsRaw.split(SEP_ALL)[0]),
    outputSchemaRef: schemaRef,
    outputDeterminism:
      archDeterminism === 'MIXED'
        ? {
            kind: 'MIXED',
            generative: perOutput?.generative ?? [],
            judgment: perOutput?.judgment ?? [],
          }
        : { kind: archDeterminism },
    tools,
    filesystemScope,
    networkScope: netRaw !== undefined ? clean(netRaw) : A_ALL.networkScopeDefault,
    allowedActions: clean(f.get('allowed') ?? ''),
    forbiddenActions: [
      ...list(f.get('forbidden') ?? ''),
      ...A_ALL.forbiddenActions,
      ...(archBlock?.additionalForbidden ?? []),
    ],
    refusalSurface: [
      ...A_ALL.refusalSurface,
      ...(refusalLabel === undefined ? [] : list(f.get(refusalLabel) ?? '')),
    ],
    requiredEvidence:
      localEvidence.length > 0 ? localEvidence : (tierBlock?.requiredEvidence ?? []),
    qualityCriteria: localQuality.length > 0 ? localQuality : (archBlock?.qualityCriteria ?? []),
    escalationConditions: [
      ...A_ALL.escalationConditions,
      ...list(f.get('escalates') ?? ''),
      ...(archBlock?.additionalEscalations ?? []),
    ],
    failureConditions: [...A_ALL.failureConditions, ...list(f.get('fails') ?? '')],
    proposalBehavior:
      A_ALL.proposalBehavior + (f.has('proposals') ? ' Local: ' + clean(f.get('proposals')) : ''),
    reviewResponsibilities:
      localReviews.length > 0 ? localReviews : (archBlock?.reviewResponsibilities ?? 'none'),
    conflictOfInterest: {
      inherited:
        'may not verify, review or accept an artifact produced by the same actor in the same work item',
      local: clean(f.get('coi') ?? 'none'),
      derived: derivedCoi,
    },
    contextBudget: budget,
    untrustedContentRule: A_ALL.untrustedContentRule,
    inherits,
    aet: aet ?? { criteria: [], justification: '' },
    resolution: {
      id: 'LOCAL',
      name: 'LOCAL',
      version: 'LOCAL',
      department: 'LOCAL',
      tier: 'DERIVED(R-TIER)',
      archetype: 'LOCAL',
      authorityLevel: 'LOCAL',
      magnitudeCeiling: 'LOCAL',
      mission: 'LOCAL',
      responsibilities: localResponsibilities.length > 0 ? 'LOCAL' : 'DERIVED(R-RESP)',
      nonResponsibilities: localNonResp.length > 0 ? 'LOCAL' : 'INHERITED(' + archBlockName + ')',
      inputs: 'LOCAL',
      outputs: 'LOCAL',
      outputSchemaRef: 'LOCAL',
      tools: toolsRaw !== undefined ? 'LOCAL' : 'INHERITED(' + tb + ')',
      filesystemScope:
        fsRaw !== undefined
          ? 'LOCAL'
          : tierBlock?.filesystemScope !== undefined
            ? 'INHERITED(' + tb + ')'
            : 'DERIVED(R-FS)',
      networkScope: netRaw !== undefined ? 'LOCAL' : 'INHERITED(A-ALL)',
      allowedActions: 'DERIVED(R-ALLOW)',
      forbiddenActions: 'LOCAL+INHERITED(A-ALL,' + archBlockName + ')',
      refusalSurface: 'INHERITED(A-ALL)+LOCAL',
      requiredEvidence:
        localEvidence.length > 0
          ? 'LOCAL'
          : tierBlock?.requiredEvidence !== undefined
            ? 'INHERITED(' + tb + ')'
            : 'NONE',
      qualityCriteria: localQuality.length > 0 ? 'LOCAL' : 'INHERITED(' + archBlockName + ')',
      escalationConditions: 'INHERITED(A-ALL)+LOCAL',
      failureConditions: 'INHERITED(A-ALL)',
      proposalBehavior: 'INHERITED(A-ALL)+LOCAL',
      reviewResponsibilities:
        localReviews.length > 0 ? 'LOCAL' : 'INHERITED(' + archBlockName + ')',
      conflictOfInterest: 'INHERITED(A-ALL)+LOCAL+DERIVED(R-COI)',
      contextBudget: 'LOCAL',
      untrustedContentRule: 'INHERITED(A-ALL)',
    },
  });
}

/* ------------------------------------------------------------ cross-checks */

const parsed = new Set(contracts.map((c) => c.id));
for (const a of catalogues.agents) {
  if (!parsed.has(a.id)) fatal('Canonical agent ' + a.id + ' (30 §4) has no contract in 32 §5');
}
for (const c of contracts) {
  const cat = catalogueAgents.get(c.id);
  if (cat === undefined) {
    fatal('Contract ' + c.id + ' references an agent absent from 30 §4');
    continue;
  }
  if (cat.departmentId !== c.department) {
    fatal(
      c.id + ': department ' + c.department + ' disagrees with 30 §4 (' + cat.departmentId + ')',
    );
  }
  if (cat.archetype !== c.archetype) {
    fatal(c.id + ': archetype ' + c.archetype + ' disagrees with 30 §4 (' + cat.archetype + ')');
  }
  if (cat.authority !== c.authorityLevel) {
    fatal(
      c.id + ': authority ' + c.authorityLevel + ' disagrees with 30 §4 (' + cat.authority + ')',
    );
  }
  for (const rel of c.conflictOfInterest.derived) {
    for (const other of rel.with) {
      if (/^SC-AGENT-\d{3}$/.test(other) && !catalogueAgents.has(other)) {
        fatal(c.id + ': conflict-of-interest relation names unknown agent ' + other);
      }
    }
  }
}
if (contracts.length !== catalogues.counts.agents) {
  fatal('Parsed ' + contracts.length + ' contracts but 30 §4 declares ' + catalogues.counts.agents);
}

if (problems.length > 0) {
  console.error('AgentContract generation FAILED — ' + problems.length + ' unresolved item(s):');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

const specDigest = createHash('sha256').update(md).digest('hex');
const payload = {
  $generated: {
    by: 'scripts/generate-agent-contracts.mjs',
    from: 'docs/serva-code/32_AGENT_CONTRACT_CATALOG.md',
    specDigest,
    specBaseline: 'R4',
    note: 'DO NOT EDIT. Regenerate with `npm run contracts` after a specification change.',
  },
  inheritance: { universal: A_ALL, archetypes: archetypeBlocks, tiers: tierBlocks },
  conflictOfInterestPairs: coiPairs,
  contracts: contracts.sort((a, b) => a.id.localeCompare(b.id)),
  counts: { contracts: contracts.length, coiPairs: coiPairs.length },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log('Wrote ' + OUT);
console.log('  contracts: ' + contracts.length + '  CoI pairs: ' + coiPairs.length);
