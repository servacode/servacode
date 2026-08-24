import { VerificationType } from './proof.js';

/**
 * EVERY MANDATORY SERVA CODE 1.0 REQUIREMENT.
 *
 * SPEC: Phase 6 closure §2, §16.
 *
 * The previous matrix listed thirty-three rows and reported 33/33 covered. The independent
 * audit found the number meaningless twice over: rows were COVERED because two files
 * existed, and the list omitted most of what Phase 6 actually required — the extension host
 * harness, the project wizard, the conversation surface, bootstrap, the installer, the
 * reconciliation workflow. A complete score over an incomplete list is worse than no score,
 * because it stops anybody looking.
 *
 * So the catalogue is the whole of it, including everything that is NOT built. A
 * requirement with no resolvable proof reports NOT_VERIFIED, and the total falls. That is
 * the point: this file is written before the implementation and does not shrink to fit it.
 *
 * `mandatory` distinguishes what gates `READY FOR OWNER USE` from what is genuinely
 * optional. Nothing in Phase 6 is currently optional, and the field exists so that a future
 * exemption has to be written down rather than achieved by deletion.
 */

export interface Requirement {
  readonly id: string;
  readonly requirement: string;
  /** The kind of proof this requirement needs. A weaker kind does not satisfy it. */
  readonly expects: VerificationType;
  /** The acceptance line this rolls up to in `serva acceptance`. */
  readonly line: string;
  readonly mandatory: boolean;
  /** Where the implementation is, for a reader. Never used to decide status. */
  readonly implementation?: string;
  /**
   * The test files whose PASSING establishes this requirement.
   *
   * Absent means no offline test establishes it — which is a statement about the product,
   * not about this file. `scripts/prove.mjs` can only mint a DETERMINISTIC proof for a
   * requirement that names its tests and whose tests actually pass, so a requirement with
   * nothing here stays NOT_VERIFIED until somebody builds and tests it.
   */
  readonly provenBy?: readonly string[];
  readonly limitation?: string;
}

export const ACCEPTANCE_LINES: readonly string[] = Object.freeze([
  'Company Specification',
  'Core Engine',
  'AI Runtime',
  'Engineering Factory',
  'Company Intelligence',
  'Lifecycle Coverage',
  'Gate Coverage',
  'Downstream Company',
  'Owner Experience',
  'VS Code Runtime',
  'Portability',
  'Recovery',
  'Machine Readiness',
  'Distribution',
  'Offline Verification',
  'Security Acceptance',
  'Live Acceptance',
]);

export const REQUIREMENTS: readonly Requirement[] = Object.freeze([
  /* ------------------------------------------------------------- phases 1 to 5 */
  {
    id: 'R4-SPEC',
    requirement: 'The 34 R4 specification documents are the baseline and are unmodified',
    expects: VerificationType.DETERMINISTIC,
    line: 'Company Specification',
    mandatory: true,
    implementation: 'docs/serva-code/',
    provenBy: ['tests/app.catalogue.test.ts'],
  },
  {
    id: 'CORE-STORE',
    requirement: 'Append-only Store with digests, transactions and crash recovery',
    expects: VerificationType.DETERMINISTIC,
    line: 'Core Engine',
    mandatory: true,
    implementation: 'src/store/store.ts',
    provenBy: ['tests/store.test.ts'],
  },
  {
    id: 'CORE-GATES',
    requirement: 'One gate engine composes every verdict; absent evidence is INDETERMINATE',
    expects: VerificationType.DETERMINISTIC,
    line: 'Core Engine',
    mandatory: true,
    implementation: 'src/gates/engine.ts',
    provenBy: ['tests/gates.compose.test.ts', 'tests/gates.authority.test.ts'],
  },
  {
    id: 'AI-CONTEXT',
    requirement: 'Context is built, persisted before invocation, and trust-marked',
    expects: VerificationType.DETERMINISTIC,
    line: 'AI Runtime',
    mandatory: true,
    implementation: 'src/context/bundle.ts',
    provenBy: ['tests/ai.security.test.ts'],
  },
  {
    id: 'AI-ADAPTER',
    requirement: 'Provider-specific code stays behind the adapter boundary',
    expects: VerificationType.DETERMINISTIC,
    line: 'AI Runtime',
    mandatory: true,
    implementation: 'src/engine/ (adapter boundary)',
    provenBy: ['tests/ai.security.test.ts'],
  },
  {
    id: 'ENG-HARD',
    requirement: 'Write-capable engineering runs only under a measured HARD boundary',
    expects: VerificationType.DETERMINISTIC,
    line: 'Engineering Factory',
    mandatory: true,
    implementation: 'src/substrate/boundary.ts',
    provenBy: ['tests/eng.binding.test.ts'],
  },
  {
    id: 'ENG-EVIDENCE',
    requirement: 'Deterministic checks are the evidence authority; agent opinion cannot pass one',
    expects: VerificationType.DETERMINISTIC,
    line: 'Engineering Factory',
    mandatory: true,
    implementation: 'src/engineering/gate.ts',
    provenBy: ['tests/eng.factory.test.ts'],
  },
  {
    id: 'INTEL-AUTHORITY',
    requirement: 'Canonical output authority is enforced at the write boundary',
    expects: VerificationType.DETERMINISTIC,
    line: 'Company Intelligence',
    mandatory: true,
    implementation: 'src/intelligence/execution/authority.ts',
    provenBy: ['tests/intel.writeauthority.test.ts'],
  },
  {
    id: 'INTEL-OWNER',
    requirement: 'Owner decisions are purpose-bound and cannot be answered by an agent',
    expects: VerificationType.DETERMINISTIC,
    line: 'Company Intelligence',
    mandatory: true,
    implementation: 'src/intelligence/artifacts/governance.ts',
    provenBy: ['tests/intel.governance.test.ts', 'tests/intel.ownervalue.test.ts'],
  },
  {
    id: 'INTEL-TRUST',
    requirement: 'Retrieved evidence is structurally UNTRUSTED end to end',
    expects: VerificationType.DETERMINISTIC,
    line: 'Company Intelligence',
    mandatory: true,
    implementation: 'src/intelligence/research/capture.ts',
    provenBy: ['tests/intel.researchtrust.test.ts'],
  },
  {
    id: 'INTEL-OBLIGATION',
    requirement: 'Routed obligations are consumed, verified and resolved, not merely recorded',
    expects: VerificationType.DETERMINISTIC,
    line: 'Company Intelligence',
    mandatory: true,
    implementation: 'src/intelligence/execution/obligations.ts',
    provenBy: ['tests/intel.obligations.test.ts'],
  },

  /* --------------------------------------------------- lifecycle and gate coverage */
  {
    id: 'P6-LIFECYCLE',
    requirement: 'All 26 canonical stages are accounted for, computed not claimed',
    expects: VerificationType.DETERMINISTIC,
    line: 'Lifecycle Coverage',
    mandatory: true,
    implementation: 'src/coverage/index.ts',
    provenBy: ['tests/coverage.test.ts'],
  },
  {
    id: 'P6-GATES',
    requirement: 'All 19 canonical gates are defined and evaluated by the gate engine',
    expects: VerificationType.DETERMINISTIC,
    line: 'Gate Coverage',
    mandatory: true,
    implementation: 'src/intelligence/gates/downstream.ts',
    provenBy: ['tests/coverage.test.ts'],
  },

  /* -------------------------------------------------------- the downstream company */
  {
    id: 'P6-QUALITY',
    requirement: 'Downstream quality verifiers are independent and record what they judged',
    expects: VerificationType.DETERMINISTIC,
    line: 'Downstream Company',
    mandatory: true,
    implementation: 'src/intelligence/departments/quality.ts',
    provenBy: ['tests/coverage.test.ts'],
  },
  {
    id: 'P6-RELEASE',
    requirement: 'Release readiness is derived; owner authority is a condition no agent satisfies',
    expects: VerificationType.DETERMINISTIC,
    line: 'Downstream Company',
    mandatory: true,
    implementation: 'src/intelligence/releaseReadiness.ts',
    provenBy: ['tests/services.test.ts'],
  },
  {
    id: 'P6-HANDOVER',
    requirement: 'A release carries a handover package with deployment steps and a rollback plan',
    expects: VerificationType.DETERMINISTIC,
    line: 'Downstream Company',
    mandatory: true,
    implementation: 'src/intelligence/departments/release.ts',
    provenBy: ['tests/coverage.test.ts'],
  },
  {
    id: 'P6-INCIDENT',
    requirement: 'An incident enters the governed lifecycle rather than becoming a patch request',
    expects: VerificationType.DETERMINISTIC,
    line: 'Downstream Company',
    mandatory: true,
    implementation: 'src/intelligence/departments/incident.ts',
    provenBy: ['tests/coverage.test.ts'],
  },
  {
    id: 'P6-LIBRARY',
    requirement: 'Cross-project knowledge is generalised, local, off by default, and deletable',
    expects: VerificationType.DETERMINISTIC,
    line: 'Downstream Company',
    mandatory: true,
    implementation: 'src/learning/library.ts',
    provenBy: ['tests/library.test.ts'],
  },

  /* ------------------------------------------------------------- owner experience */
  {
    id: 'P6-SERVICES',
    requirement: 'One company underneath: CLI and extension call the same services',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
    implementation: 'src/app/services.ts',
    provenBy: ['tests/services.test.ts'],
  },
  {
    id: 'P6-ACTIONS',
    requirement: 'Every consequential action is validated and explicitly confirmed',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
    implementation: 'src/app/actions.ts',
    provenBy: ['tests/services.test.ts'],
  },
  {
    id: 'P6-CLI-PARITY',
    requirement: 'The CLI and the extension dispatch against the same action table',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
    implementation: 'src/cli/commands/portability.ts',
    provenBy: ['tests/services.test.ts'],
  },
  {
    id: 'UX-NEW-PROJECT',
    requirement:
      'A VS Code New Project flow collects business inputs only and uses the same creation service as the CLI',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
    provenBy: ['tests/newproject.test.ts', 'tests/vscode/newProject.host.test.ts'],
  },
  {
    id: 'UX-OWNER-VALUE',
    requirement:
      'A VALUE owner decision can be answered end to end from the Control Center, with confirmation and persistence',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
    provenBy: ['tests/extension.ownervalue.test.ts', 'tests/vscode/ownerValue.host.test.ts'],
  },
  {
    id: 'UX-CONVERSATION',
    requirement:
      'A governed conversation surface routes owner requests through classification and orchestration, never to an unrestricted model session',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
  },
  {
    id: 'UX-RECONCILIATION',
    requirement:
      'External divergence is classified and resolved through governed owner choices, adopting and deleting nothing silently',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
  },
  {
    id: 'UX-CONTROL-CENTER',
    requirement:
      'The Control Center exposes the built information areas usably, with no decorative empty sections',
    expects: VerificationType.DETERMINISTIC,
    line: 'Owner Experience',
    mandatory: true,
  },

  /* ---------------------------------------------------------------- VS Code runtime */
  {
    id: 'P6-WEBVIEW',
    requirement: 'Project content becomes text, never markup; the CSP permits one nonce',
    expects: VerificationType.DETERMINISTIC,
    line: 'VS Code Runtime',
    mandatory: true,
    implementation: 'src/extension/render.ts',
    provenBy: ['tests/extension.test.ts'],
  },
  {
    id: 'P6-PROTOCOL',
    requirement: 'A forged webview message can only name an action that already exists',
    expects: VerificationType.DETERMINISTIC,
    line: 'VS Code Runtime',
    mandatory: true,
    implementation: 'src/extension/protocol.ts',
    provenBy: ['tests/extension.test.ts'],
  },
  {
    id: 'P6-RTL',
    requirement: 'Arabic mirrors the layout; technical content keeps its direction',
    expects: VerificationType.DETERMINISTIC,
    line: 'VS Code Runtime',
    mandatory: true,
    implementation: 'src/extension/i18n.ts',
    provenBy: ['tests/extension.test.ts'],
  },
  {
    id: 'P6-A11Y',
    requirement: 'Focus is visible, targets are large enough, sections are labelled',
    expects: VerificationType.DETERMINISTIC,
    line: 'VS Code Runtime',
    mandatory: true,
    implementation: 'extension/media/style.css',
    limitation:
      'Automated checks only. No formal accessibility certification is claimed, and none is implied.',
    provenBy: ['tests/extension.test.ts'],
  },
  {
    id: 'EXT-HOST',
    requirement:
      'The extension entrypoint is exercised inside a real VS Code Extension Host: activation, discovery, commands, decisions, backup, restore, reconciliation, restart',
    expects: VerificationType.DETERMINISTIC,
    line: 'VS Code Runtime',
    mandatory: true,
  },

  /* ------------------------------------------------------------------ portability */
  {
    id: 'P6-BACKUP',
    requirement: 'A backup is verified before it is called one, and carries no credential',
    expects: VerificationType.DETERMINISTIC,
    line: 'Portability',
    mandatory: true,
    implementation: 'src/portability/backup.ts',
    provenBy: ['tests/portability.test.ts'],
  },
  {
    id: 'BACKUP-IDENTITY',
    requirement:
      'Backup project identity comes from the Store; the extension never invents it, and CLI and VS Code produce equivalent manifests',
    expects: VerificationType.DETERMINISTIC,
    line: 'Portability',
    mandatory: true,
  },
  {
    id: 'P6-RESTORE',
    requirement: 'Restore inspects before it writes and refuses to overwrite silently',
    expects: VerificationType.DETERMINISTIC,
    line: 'Portability',
    mandatory: true,
    implementation: 'src/portability/restore.ts',
    provenBy: ['tests/portability.test.ts'],
  },
  {
    id: 'RESTORE-FRESH',
    requirement:
      'Restore works from a fresh environment with no existing Serva project open — the core new-machine scenario',
    expects: VerificationType.DETERMINISTIC,
    line: 'Portability',
    mandatory: true,
  },
  {
    id: 'P6-ARCHIVE-SAFETY',
    requirement: 'A backup is hostile input: traversal, symlinks and extras are refused',
    expects: VerificationType.DETERMINISTIC,
    line: 'Portability',
    mandatory: true,
    implementation: 'src/portability/backup.ts',
    provenBy: ['tests/portability.test.ts'],
  },
  {
    id: 'P6-MIGRATION',
    requirement: 'Migration is forward, visible, snapshot-first, and refuses the unknown',
    expects: VerificationType.DETERMINISTIC,
    line: 'Portability',
    mandatory: true,
    implementation: 'src/portability/migration.ts',
    provenBy: ['tests/portability.test.ts'],
  },
  {
    id: 'MIGRATE-WORKFLOW',
    requirement:
      'A guided migration workflow orchestrates the real primitives across two machines and records completion, rather than printing a checklist',
    expects: VerificationType.DETERMINISTIC,
    line: 'Portability',
    mandatory: true,
  },
  {
    id: 'PORTABILITY-FINAL',
    requirement:
      'A real backup and restore was performed on this machine, with inventory equivalence and no machine-bound authority carried',
    expects: VerificationType.HUMAN,
    line: 'Portability',
    mandatory: true,
  },

  /* -------------------------------------------------------------------- recovery */
  {
    id: 'P6-HARD-NOT-TRANSFERRED',
    requirement: 'A restored machine begins UNQUALIFIED; HARD never travels',
    expects: VerificationType.DETERMINISTIC,
    line: 'Recovery',
    mandatory: true,
    implementation: 'src/portability/machine.ts',
    provenBy: ['tests/portability.test.ts'],
  },
  {
    id: 'P6-RECOVERY',
    requirement:
      'An operation whose final state is unknown reports RECOVERY REQUIRED and is never retried silently',
    expects: VerificationType.DETERMINISTIC,
    line: 'Recovery',
    mandatory: true,
    implementation: 'src/app/services.ts',
    provenBy: ['tests/services.test.ts'],
  },

  /* ------------------------------------------------------------ machine readiness */
  {
    id: 'P6-DOCTOR',
    requirement: 'The doctor measures and never reports READY for what it could not measure',
    expects: VerificationType.DETERMINISTIC,
    line: 'Machine Readiness',
    mandatory: true,
    implementation: 'src/portability/doctor.ts',
    provenBy: ['tests/portability.test.ts'],
  },
  {
    id: 'MACHINE-BOOTSTRAP',
    requirement:
      'A guided bootstrap workflow plans and performs safe remediation, asks before consequential changes, stops at human authentication, and resumes',
    expects: VerificationType.DETERMINISTIC,
    line: 'Machine Readiness',
    mandatory: true,
  },
  {
    id: 'STATUS-BOUNDARY-SEMANTICS',
    requirement:
      'The owner-facing status represents the RECIPE and PRODUCER boundaries distinctly and unambiguously',
    expects: VerificationType.DETERMINISTIC,
    line: 'Machine Readiness',
    mandatory: true,
  },

  /* ---------------------------------------------------------------- distribution */
  {
    id: 'VERSION-IDENTITY',
    requirement:
      'One coherent product version across package, lockfile, runtime, extension and backup manifest',
    expects: VerificationType.DETERMINISTIC,
    line: 'Distribution',
    mandatory: true,
    provenBy: ['tests/version.identity.test.ts'],
  },
  {
    id: 'INSTALL-UPDATE',
    requirement:
      'A local installable runtime and extension, with integrity metadata, update preview, backup before a schema-changing update, rollback and a doctor afterwards',
    expects: VerificationType.DETERMINISTIC,
    line: 'Distribution',
    mandatory: true,
  },
  {
    id: 'P6-DOCS',
    requirement: 'Owner documentation covers getting started through recovery',
    expects: VerificationType.HUMAN,
    line: 'Distribution',
    mandatory: true,
    implementation: 'docs/owner/',
  },

  /* ------------------------------------------------------------- the three gates */
  {
    id: 'OFFLINE-VERIFICATION',
    requirement:
      'npm run verify passes over the exact implementation tree, with machine-readable results',
    expects: VerificationType.DETERMINISTIC,
    line: 'Offline Verification',
    mandatory: true,
  },
  {
    id: 'SECURITY-INDEPENDENT',
    requirement:
      'A governed independent reviewer, with no write authority over the reviewed work, judged the exact implementation commit and left no unresolved Critical or High finding',
    expects: VerificationType.JUDGED,
    line: 'Security Acceptance',
    mandatory: true,
  },
  {
    id: 'LIVE-ENGINEERING',
    requirement:
      'A real HARD Producer, deterministic checks, a real independent Reviewer, the Engineering Gate and an accepted disposable commit, on a named machine',
    expects: VerificationType.LIVE,
    line: 'Live Acceptance',
    mandatory: true,
  },
  {
    id: 'LIVE-SERVA',
    requirement:
      'The whole chain: owner request, governed intelligence, readiness, work item, live engineering, accepted commit',
    expects: VerificationType.LIVE,
    line: 'Live Acceptance',
    mandatory: true,
  },
]);

export function requirementsFor(line: string): readonly Requirement[] {
  return REQUIREMENTS.filter((r) => r.line === line);
}

export function requirementById(id: string): Requirement | undefined {
  return REQUIREMENTS.find((r) => r.id === id);
}
