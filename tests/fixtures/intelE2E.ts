import { ARTIFACT_TYPES } from '../../src/intelligence/repository.js';
import type { Retriever, RetrievedPage } from '../../src/intelligence/research/gateway.js';
import type {
  EngineAdapter,
  InvocationRequest,
  InvocationResult,
  InvokeOptions,
} from '../../src/engine/types.js';
import type { Store } from '../../src/store/store.js';

/**
 * SCRIPTED OUTPUTS FOR THE END-TO-END SCENARIO.
 *
 * One entry per department, in the order the orchestrator runs them. Kept in a fixture
 * rather than inline so the test reads as a set of assertions about the company rather
 * than a wall of sample data.
 *
 * The content is a small real product — a bakery losing phone orders — chosen because it
 * has genuine business rules, a genuine money question, and a current alternative that is
 * a paper notepad rather than a competitor. Products lose to notepads more often than to
 * rivals, and a fixture that forgot that would be testing the easy case.
 */

function envelope(result: unknown): Record<string, unknown> {
  return {
    status: 'COMPLETED',
    result,
    selfReview: {
      contractConformance: 'stayed within the contract',
      scopeConformance: 'within the declared scope',
      knownGaps: [],
      confidence: 'MEDIUM',
      assumptionsMade: [],
    },
    observations: [],
    escalations: [],
    evidenceClaims: [],
    unresolved: [],
  };
}

const REVIEW_ACCEPTED = {
  verdict: 'ACCEPTABLE' as const,
  summary: 'Reviewed independently; nothing blocking remains.',
  findings: [],
};

/** Ordered [agentId, envelope] pairs. Repeats are queued for repeat callers. */
export const E2E_SCRIPT: readonly (readonly [string, Record<string, unknown>])[] = [
  /* --- 002 intake --- */
  [
    'SC-AGENT-020',
    envelope({
      problem: 'Independent bakeries lose orders taken by phone during the morning rush.',
      audience: 'Small bakery owners and their counter staff',
      successDefinition: 'No order taken during the rush is lost or duplicated.',
      commercialRequirements: ['affordable for a single-site bakery'],
      goals: [
        {
          statement: 'Capture every phone order reliably during peak hours',
          successIndicator: 'zero lost orders reported over four weeks',
          priority: 'MUST',
        },
      ],
      constraints: [
        { type: 'TIME', statement: 'ready before the winter season', negotiable: true },
      ],
      openQuestions: [],
    }),
  ],

  /* --- 003 discovery --- */
  [
    'SC-AGENT-030',
    envelope({
      summary: 'Counter staff take phone orders on paper during a rush and transcribe them later.',
      segments: [
        {
          name: 'Counter staff',
          description: 'Serve walk-ins and answer the phone simultaneously',
          goals: ['take an order without losing the walk-in queue'],
          context: 'Peak 07:00-09:30, both hands busy',
          jobs: [
            { statement: 'Record a phone order while serving', currentSolution: 'paper notepad' },
          ],
          pains: [
            { statement: 'Orders are transcribed later and sometimes lost', severity: 'BLOCKING' },
          ],
          alternatives: [
            {
              kind: 'MANUAL_PROCESS',
              description: 'A paper notepad by the till',
              whyUsed: 'instant, needs no login, works with flour on your hands',
              weaknesses: ['illegible', 'lost', 'no record after the shift'],
            },
          ],
        },
      ],
      researchPerformed: { interviews: 0, surveys: 0, usabilityTests: 0, deskResearch: true },
      limitations: ['No bakery staff were interviewed; segment behaviour is desk research only.'],
      assumptions: [
        {
          statement: 'Staff will accept a screen during a rush',
          loadBearing: true,
          validationApproach: 'observe one morning service before build',
          ifWrong: 'the product is unusable at exactly the moment it is needed',
        },
      ],
    }),
  ],

  /* --- 004 product validation --- */
  [
    'SC-AGENT-020',
    envelope({
      outcome: 'PROCEED',
      rationale: 'The notepad loses orders and nothing else in the shop records them.',
      conditions: [],
      features: [
        {
          name: 'Rapid order capture',
          description: 'One-screen capture of a phone order in under fifteen seconds',
          goalIndexes: [0],
          priority: 'MUST',
        },
      ],
      outOfScope: [{ statement: 'Delivery routing', reason: 'no bakery in the segment delivers' }],
      nonGoals: [
        {
          statement: 'Becoming an EPOS system',
          reason: 'the till already works and staff trust it',
        },
      ],
      scopeRationale: 'Solve the rush, not the shop.',
      ownerDecisions: [],
    }),
  ],

  /* --- 010 business analysis (no invented money) --- */
  [
    'SC-AGENT-040',
    envelope({
      actors: [
        { name: 'Counter staff', description: 'takes phone orders', permissions: ['create order'] },
      ],
      rules: [
        {
          statement: 'An order must record the time it was taken',
          rationale: 'disputes are resolved by sequence',
          authority: 'DERIVED',
          appliesTo: ['Order'],
        },
      ],
      processes: [],
      stateMachines: [
        {
          entity: 'Order',
          states: ['TAKEN', 'FULFILLED', 'CANCELLED'],
          initialState: 'TAKEN',
          terminalStates: ['FULFILLED', 'CANCELLED'],
          transitions: [
            { from: 'TAKEN', to: 'FULFILLED', trigger: 'collected', guard: 'payment received' },
            { from: 'TAKEN', to: 'CANCELLED', trigger: 'customer cancels', guard: 'not yet baked' },
          ],
        },
      ],
      glossary: [{ term: 'Order', definition: 'A request for goods taken from a named customer' }],
      financial: [],
      contradictions: [],
    }),
  ],

  /* --- 011 requirements, NFRs, independent verifier --- */
  [
    'SC-AGENT-050',
    envelope({
      requirements: [
        {
          statement:
            'The system shall record a phone order with customer name, items and the time taken',
          kind: 'FUNCTIONAL',
          priority: 'MUST',
          rationale: 'orders taken on paper are lost',
          featureIndex: 0,
          acceptanceCriteria: [
            {
              criterion: 'An order saved during a rush is retrievable after the shift',
              verificationMethod: 'AUTOMATED_TEST',
            },
          ],
        },
      ],
    }),
  ],
  [
    'SC-AGENT-051',
    envelope({
      nfrs: [
        {
          dimension: 'PERFORMANCE',
          statement: 'Order capture must complete within the rush',
          target: 'p95 under 15 seconds from first keystroke to saved',
          measurementMethod: 'timed script against the capture screen',
          applicability: 'the order capture flow only',
          rationale: 'staff cannot leave the counter for longer',
        },
      ],
    }),
  ],
  [
    'SC-AGENT-052',
    envelope({
      verdict: 'ACCEPTABLE',
      summary: 'Requirements are atomic, traceable, and each MUST is checkable.',
      findings: [],
    }),
  ],

  /* --- 013 research chain --- */
  [
    'SC-AGENT-060',
    envelope({
      findings: [
        {
          question: 'what do rivals charge',
          finding: 'Rival A charges 29 GBP per month and offers phone order capture.',
          captureIds: ['__CAPTURE_0__'],
          confidence: 'HIGH',
        },
      ],
      competitors: [
        {
          name: 'Rival A',
          positioning: 'order capture for small food businesses',
          features: ['phone order capture'],
          captureIds: ['__CAPTURE_0__'],
        },
      ],
      unanswered: [],
    }),
  ],
  [
    'SC-AGENT-063',
    envelope({
      verifications: [
        {
          findingId: '__FINDING_0__',
          verdict: 'SUPPORTED',
          reasoning: 'The captured page states the price and the capability directly.',
        },
      ],
    }),
  ],
  [
    'SC-AGENT-061',
    envelope({
      tableStakes: [
        {
          capability: 'Capture a phone order and retrieve it later',
          whyExpected: 'the one rival in this segment already does it',
          findingIds: ['__FINDING_0__'],
        },
      ],
      gaps: [
        {
          description: 'Nothing in the segment is designed for one-handed use during a rush',
          findingIds: ['__FINDING_0__'],
          confidence: 'MEDIUM',
          whyUnfilled: 'rivals target multi-site operators who take orders at a desk',
        },
      ],
    }),
  ],
  [
    'SC-AGENT-062',
    envelope({
      differentiators: [
        {
          statement: 'An order is captured in under fifteen seconds with one hand',
          basis: 'timed against the paper notepad it replaces, not against a rival',
          defensibility: 'WEAK',
          defensibilityRationale:
            'copyable once noticed, but the segment is small enough to be uninteresting to larger rivals',
          competitorCoverage: [{ competitorName: 'Rival A', coverage: 'ABSENT' }],
        },
      ],
      position: {
        whyChosen: 'It is faster than the notepad and, unlike the notepad, it remembers.',
        reasonToSwitch: 'The notepad loses orders and nothing else in the shop records them.',
        reasonToStay:
          'The notepad is free, instant, needs no login, survives flour and a dropped phone, and every member of staff already knows how to use it.',
        nonGoals: ['Becoming an EPOS system'],
      },
      proposals: [
        {
          title: 'Voice capture during the rush',
          description: 'Take the order by speaking instead of typing',
          userOrBusinessValue: 'genuinely hands-free',
          evidenceBasis: 'both hands are busy during peak, per discovery',
          implementationComplexity: 'HIGH',
          costImpact: 'per-minute speech API cost, unbounded at peak',
          risk: 'a bakery at 7am is loud; recognition accuracy is unproven here',
          operationalBurden: 'staff must correct mistranscriptions under time pressure',
          scopeEffect: 'adds a whole input modality to a product whose value is speed',
        },
      ],
    }),
  ],

  /* --- 015 cost --- */
  [
    'SC-AGENT-110',
    envelope({
      buildCost: {
        amount: 12000,
        currency: 'GBP',
        basis: 'ESTIMATED',
        basisDetail: 'comparable single-screen capture products at agency day rates',
        confidence: 'LOW',
      },
      runCost: [
        {
          item: 'hosting',
          amount: 25,
          currency: 'GBP',
          period: 'PER_MONTH',
          basis: 'ESTIMATED',
          basisDetail: 'a small managed instance and a managed database',
          confidence: 'MEDIUM',
        },
      ],
      assumptions: ['single site, under 200 orders per day'],
      narrative: 'Build dominates; running costs are small and predictable at this scale.',
      exceedsBudget: false,
    }),
  ],

  /* --- 016 risk is computed, not scripted --- */

  /* --- 020 architecture, review, infrastructure --- */
  [
    'SC-AGENT-070',
    envelope({
      style: 'A single deployable web application with a relational store',
      rationale:
        'One bakery, one till, a few hundred orders a day. Nothing in the requirements forces distribution.',
      modules: [
        { name: 'OrderCapture', responsibility: 'record and retrieve orders', owns: ['Order'] },
      ],
      interactions: [],
      moduleContracts: [
        {
          ownerModule: 'OrderCapture',
          interface: 'createOrder, listOrdersForShift',
          invariants: ['an order always records the time it was taken'],
        },
      ],
      ssot: [{ truthElement: 'Order', location: 'OrderCapture', consumers: [] }],
      complexity: [],
      nfrMapping: [
        {
          nfrId: '__NFR_0__',
          status: 'SATISFIED',
          mechanism: 'single round trip on save; no network call during entry',
          verification: 'timed script against the capture screen',
        },
      ],
      specificationGaps: [],
    }),
  ],
  ['SC-AGENT-072', envelope(REVIEW_ACCEPTED)],
  [
    'SC-AGENT-100',
    envelope({
      environments: [
        { name: 'production', purpose: 'the live bakery', dataPolicy: 'real order data' },
        { name: 'staging', purpose: 'pre-release checks', dataPolicy: 'synthetic data only' },
      ],
      deployment: {
        approach: 'single rolling deploy',
        rolloutControl: 'deploy behind a health check; revert on failure',
        downtimeExpectation: 'none expected; a few seconds acceptable outside 07:00-09:30',
        rationale: 'a one-site product does not need progressive delivery',
      },
      observability: {
        logs: 'structured application logs retained 30 days',
        metrics: ['orders saved per minute', 'save latency p95'],
        alerts: [
          {
            condition: 'save latency p95 over 15s during peak',
            severity: 'HIGH',
            response: 'page the on-call engineer',
          },
        ],
      },
      rollback: {
        mechanism: 'redeploy the previous image',
        dataImplications: 'schema changes are additive only, so rollback needs no data migration',
      },
    }),
  ],

  /* --- 021 data + independent review --- */
  [
    'SC-AGENT-080',
    envelope({
      entities: [
        {
          name: 'Order',
          description: 'A phone order taken during a shift',
          ownerModule: 'OrderCapture',
          identifierStrategy: 'ULID, generated at capture',
          attributes: [
            { name: 'customerName', type: 'string', required: true },
            { name: 'takenAt', type: 'timestamp', required: true },
          ],
        },
      ],
      relations: [],
      transactionBoundaries: ['an order and its items are saved atomically'],
      classification: [
        {
          dataElement: 'customerName',
          class: 'PERSONAL',
          purpose: 'to hand the right bag to the right person',
          handlingRules: ['not exported', 'not used for marketing'],
        },
      ],
      retention: [
        {
          dataClass: 'PERSONAL',
          retention: '90 days after collection',
          deletionMethod: 'ANONYMISE',
          basis: 'long enough to resolve a dispute, short enough not to accumulate',
        },
      ],
    }),
  ],
  ['SC-AGENT-082', envelope(REVIEW_ACCEPTED)],

  /* --- 022 security --- */
  [
    'SC-AGENT-090',
    envelope({
      depth: 'STANDARD',
      scope: 'the order capture application and its store',
      trustBoundaries: [
        {
          from: 'the public internet',
          to: 'the application',
          controls: ['TLS', 'session authentication'],
          dataCrossing: ['order details'],
        },
      ],
      threats: [
        {
          id: 'T1',
          statement: 'An unauthenticated caller reads another bakery’s orders',
          affects: 'Order',
          mitigations: ['every query is scoped to the authenticated tenant'],
        },
      ],
      abuseCases: [
        {
          actor: 'a former employee',
          goal: 'export the customer list',
          method: 'use a still-valid session to page through orders',
          impact: 'personal data disclosure',
          mitigations: [
            'sessions expire on role change',
            'bulk reads are rate limited and audited',
          ],
        },
      ],
      auth: {
        identitySources: ['staff accounts created by the owner'],
        mechanisms: ['password with server-side session'],
        sessionModel: 'server session, 12 hours, revoked on role change',
        rationale: 'the smallest thing that supports revocation on a shared device',
      },
      authorization: {
        model: 'RBAC',
        entries: [
          { role: 'Counter staff', resource: 'Order', action: 'create', effect: 'ALLOW' },
          { role: 'Counter staff', resource: 'Order', action: 'delete', effect: 'DENY' },
        ],
      },
      secrets: {
        storage: 'environment-injected, never in the repository',
        rotation: 'on staff change and at least annually',
        distribution: 'deployment platform secret store',
      },
      privacy: {
        dataInventory: [
          {
            data: 'customer name and phone number',
            why: 'to complete and hand over the order',
            accessibleBy: ['Counter staff', 'Owner'],
          },
        ],
        subjectRights: ['deletion on request'],
        expertReviewRequired: true,
        expertReviewReason:
          'whether 90-day retention of customer contact details satisfies local law is a question for a professional, not for Serva',
      },
      residualRisks: [],
    }),
  ],

  /* --- 023 technology --- */
  [
    'SC-AGENT-071',
    envelope({
      decisions: [
        {
          area: 'Primary datastore',
          criteria: [
            {
              name: 'transactional integrity',
              rationale: 'an order and its items save atomically',
            },
            {
              name: 'operational simplicity',
              rationale: 'a one-site product has no platform team',
            },
          ],
          candidates: [
            {
              name: 'PostgreSQL',
              scores: [
                { criterion: 'transactional integrity', score: 5, basis: 'ACID, mature' },
                {
                  criterion: 'operational simplicity',
                  score: 4,
                  basis: 'managed offerings are ubiquitous',
                },
              ],
              costNote: 'small managed instance',
              lockInNote: 'standard SQL; portable',
            },
            {
              name: 'SQLite',
              scores: [
                { criterion: 'transactional integrity', score: 5, basis: 'ACID' },
                { criterion: 'operational simplicity', score: 5, basis: 'a file' },
              ],
              costNote: 'none',
              lockInNote: 'none',
            },
          ],
          chosen: 'PostgreSQL',
          rationale:
            'SQLite scores as well and would work today, but a second till or a second site needs concurrent writers, and migrating a live bakery mid-service is worse than the small managed cost.',
          rejectedReasons: [
            'SQLite: single-writer becomes a constraint the moment a second device appears',
          ],
          consequences: ['a managed database to pay for and patch'],
          reversalCost: 'MEDIUM',
          reevaluationTrigger: 'if the product stays single-device for a year, revisit SQLite',
        },
      ],
    }),
  ],

  /* --- 024 UX + independent review --- */
  [
    'SC-AGENT-120',
    envelope({
      journeys: [
        {
          name: 'Take a phone order during the rush',
          goal: 'record the order without losing the walk-in queue',
          steps: [
            { action: 'answer the phone', systemResponse: 'capture screen is already open' },
            { action: 'type the name and items', systemResponse: 'each entry is saved as typed' },
          ],
        },
      ],
      flows: [
        {
          name: 'Capture order',
          entryPoints: ['the always-open capture screen'],
          steps: ['enter name', 'enter items', 'save'],
          requirementIds: ['__REQ_0__'],
          screens: [
            {
              screen: 'Capture',
              states: [
                {
                  state: 'DEFAULT',
                  disposition: 'DEFINED',
                  behaviour: 'empty form, cursor in name',
                },
                { state: 'EMPTY', disposition: 'DEFINED', behaviour: 'no orders yet this shift' },
                {
                  state: 'LOADING',
                  disposition: 'DEFINED',
                  behaviour: 'save spinner on the button only',
                },
                {
                  state: 'PARTIAL',
                  disposition: 'DEFINED',
                  behaviour: 'draft retained if the call drops',
                },
                {
                  state: 'ERROR',
                  disposition: 'DEFINED',
                  behaviour: 'keep the text, show a retry',
                },
                {
                  state: 'PERMISSION_DENIED',
                  disposition: 'DEFINED',
                  behaviour: 'explain who to ask, do not clear the form',
                },
                {
                  state: 'SUCCESS',
                  disposition: 'DEFINED',
                  behaviour: 'confirm and clear for the next call',
                },
              ],
            },
          ],
        },
      ],
      informationArchitecture: [{ name: 'Capture', contains: ['order form', 'today’s orders'] }],
      navigationPattern: 'single screen with a shift list behind one tap',
      rationale: 'During a rush, navigation is a cost. There is one screen.',
    }),
  ],
  ['SC-AGENT-123', envelope(REVIEW_ACCEPTED)],

  /* --- 025 design system, UI, independent review --- */
  [
    'SC-AGENT-130',
    envelope({
      primitives: [
        { name: 'blue.600', category: 'color', value: '#0b5fff' },
        { name: 'grey.900', category: 'color', value: '#111318' },
        { name: 'space.2', category: 'spacing', value: '8px' },
      ],
      semantic: [
        {
          name: 'color.action.primary',
          category: 'color',
          references: 'blue.600',
          purpose: 'primary action',
        },
        {
          name: 'color.text.default',
          category: 'color',
          references: 'grey.900',
          purpose: 'body text',
        },
        {
          name: 'spacing.inline',
          category: 'spacing',
          references: 'space.2',
          purpose: 'inline gap',
        },
      ],
      components: [
        {
          name: 'Button',
          anatomy: ['label'],
          states: [
            { state: 'default', appearance: 'filled', tokens: ['color.action.primary'] },
            { state: 'hover', appearance: 'darkened', tokens: ['color.action.primary'] },
            { state: 'focus', appearance: 'visible ring', tokens: ['color.action.primary'] },
            { state: 'active', appearance: 'pressed', tokens: ['color.action.primary'] },
            { state: 'disabled', appearance: 'muted', tokens: ['color.text.default'] },
            { state: 'loading', appearance: 'spinner replaces label', tokens: [] },
            { state: 'error', appearance: 'error outline', tokens: ['color.text.default'] },
          ],
          keyboard: ['Enter activates', 'Space activates'],
          minTargetPx: 48,
          mirrorsUnderRtl: true,
          directionalProperties: ['margin-inline-start'],
        },
      ],
      layout: {
        grid: 'single column, max 720px',
        breakpoints: [
          { name: 'sm', min: '0px' },
          { name: 'md', min: '768px' },
        ],
        spacingScale: ['space.2'],
      },
      rtl: {
        supported: true,
        logicalProperties: ['margin-inline-start', 'padding-inline-end'],
        neverMirror: ['phone numbers', 'the shop logo'],
      },
      accessibility: {
        targetStandard: 'WCAG 2.2 AA',
        minTargetPx: 48,
        keyboardModel: 'every action reachable by keyboard in visual order',
        focusVisible: 'a 2px ring that never relies on colour alone',
        contrastMinimums: [{ context: 'body text', ratio: 4.5 }],
      },
    }),
  ],
  ['SC-AGENT-131', envelope({ screens: [{ screen: 'Capture', componentNames: ['Button'] }] })],
  ['SC-AGENT-133', envelope(REVIEW_ACCEPTED)],

  /* --- 026 admin operability --- */
  [
    'SC-AGENT-140',
    envelope({
      reviews: [
        {
          featureName: 'Rapid order capture',
          whatOperatorMustView: ['today’s orders', 'orders that failed to save'],
          whatIsConfigurable: ['shift start and end times'],
          whatCanBeOverridden: ['re-open a cancelled order'],
          whatShouldBeAutomated: ['clearing the form after save'],
          whatMustNeverBeConfigurable: ['the recorded time an order was taken'],
          whatRequiresAudit: ['re-open a cancelled order'],
          whatRequiresConfirmation: ['re-open a cancelled order'],
          roleSeparation: ['only the owner may change shift times'],
          conclusion:
            'The operator needs visibility and two controls. The recorded time is evidence and is never editable.',
        },
      ],
      configuration: [
        {
          element: 'shift start and end times',
          classification: 'OPERATOR_CONFIGURABLE',
          justification: 'bakeries change opening hours seasonally',
          historicallySignificant: false,
          effectiveDated: false,
          requiresAudit: false,
          requiresConfirmation: false,
          reversible: true,
        },
        {
          element: 're-open a cancelled order',
          classification: 'PRIVILEGED',
          justification: 'corrects a mistake, but changes what the record says happened',
          historicallySignificant: false,
          effectiveDated: false,
          requiresAudit: true,
          requiresConfirmation: true,
          reversible: false,
        },
      ],
      protectedRules: [
        {
          rule: 'the recorded time an order was taken',
          protectionReason: 'HISTORICAL_INTEGRITY',
          explanation: 'disputes are resolved by sequence; an editable timestamp is not evidence',
        },
      ],
      auditRequirements: [
        {
          action: 're-open a cancelled order',
          captures: ['who', 'which order', 'when', 'the previous state'],
        },
      ],
      controls: [
        {
          name: 'Re-open cancelled order',
          effect: 'returns a cancelled order to TAKEN',
          destructive: false,
          reversible: true,
        },
      ],
      adminSections: [{ name: 'Shift', purpose: 'view today and adjust hours' }],
    }),
  ],

  /* --- 030 test design --- */
  [
    'SC-AGENT-210',
    envelope({
      approach: 'Specification-derived cases, automated where the behaviour is deterministic.',
      levels: ['UNIT', 'INTEGRATION', 'END_TO_END'],
      coverage: [
        {
          targetId: '__REQ_0__',
          targetKind: 'REQUIREMENT',
          level: 'INTEGRATION',
          approach: 'save an order and read it back after a simulated shift boundary',
        },
      ],
      outOfScope: ['load testing beyond a single site'],
      cases: [
        {
          title: 'An order saved during a rush is retrievable after the shift',
          derivedFromIds: ['__REQ_0__'],
          level: 'INTEGRATION',
          kind: 'HAPPY_PATH',
          steps: ['save an order', 'advance past the shift boundary', 'list the shift'],
          expected: 'the order is present with the time it was taken',
        },
        {
          title: 'A cancelled order cannot transition to FULFILLED',
          derivedFromIds: ['__REQ_0__'],
          level: 'UNIT',
          kind: 'STATE_TRANSITION',
          steps: ['cancel an order', 'attempt to fulfil it'],
          expected: 'the transition is refused',
        },
      ],
    }),
  ],
];

/** Pages the fake retriever serves. Never touches the network. */
export function seedRetriever(): Retriever {
  const pages: Record<string, string> = {
    'https://example.com/rival-a':
      'Rival A — order capture for small food businesses. 29 GBP per month. Includes phone order capture and a daily summary.',
  };
  return {
    fetch: async (url: string): Promise<RetrievedPage> => {
      const text = pages[url];
      if (text === undefined) return { url, title: '', text: '', ok: false, error: '404' };
      return { url, title: 'Rival A pricing', text, ok: true };
    },
    discover: async (): Promise<readonly string[]> => Object.keys(pages),
  };
}

/**
 * Resolve id placeholders against the live Store.
 *
 * A scripted department cannot know the ids earlier departments will generate — they come
 * from the id source at write time. Rather than weakening the schemas to accept made-up
 * ids, the fixture writes `__REQ_0__` and this substitutes the real one just before the
 * payload reaches the runtime.
 *
 * The strictness that matters is preserved: departments still refuse a citation that
 * resolves to nothing, so the E2E genuinely proves a real id was threaded through.
 */
const PLACEHOLDERS: readonly (readonly [RegExp, string])[] = [
  [/__CAPTURE_(\d+)__/g, ARTIFACT_TYPES.SOURCE_CAPTURE],
  [/__FINDING_(\d+)__/g, ARTIFACT_TYPES.RESEARCH_FINDING],
  [/__REQ_(\d+)__/g, ARTIFACT_TYPES.REQUIREMENT],
  [/__NFR_(\d+)__/g, ARTIFACT_TYPES.NFR],
];

export function resolvePlaceholders<T>(store: Store, payload: T): T {
  let json = JSON.stringify(payload);
  for (const [pattern, type] of PLACEHOLDERS) {
    const ids = store.listCanonIds(type);
    json = json.replace(pattern, (_match: string, index: string) => {
      const resolved = ids[Number.parseInt(index, 10)];
      /* Leave it unresolved rather than substituting a lie; the department will refuse it. */
      return resolved ?? '__UNRESOLVED__';
    });
  }
  return JSON.parse(json) as T;
}

/** A FakeEngineAdapter whose payloads are resolved against the Store at call time. */
export function resolvingEngine(inner: EngineAdapter, store: Store): EngineAdapter {
  return {
    ...(inner.executionLocation === undefined
      ? {}
      : { executionLocation: inner.executionLocation }),
    id: inner.id,
    health: () => inner.health(),
    capabilities: () => inner.capabilities(),
    estimate: (request: InvocationRequest) => inner.estimate(request),
    invoke: async (request: InvocationRequest, opts?: InvokeOptions): Promise<InvocationResult> => {
      const result = await inner.invoke(request, opts);
      if (result.structuredOutput === undefined) return result;
      return { ...result, structuredOutput: resolvePlaceholders(store, result.structuredOutput) };
    },
  };
}
