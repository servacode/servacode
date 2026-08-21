# 15 — TESTING AND QA

**Document ID:** SC-DOC-015
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Test strategy model, test levels, test case derivation, defect model, QA process and verdicts, coverage semantics.
**Does not own:** Evidence integrity (`16`), gate mechanics (`18`), security test scope (`17`).

---

## 1. Mandate

QA answers one question with evidence: **does the system do what was required, including when things go wrong?**

Two structural rules shape everything below:

- **Tests derive from requirements, not from the implementation** (`06` SC-DEPT-051). A test written from the code tests what was built; only a test written from the acceptance criterion tests what was asked for.
- **A test result is evidence only if it was captured by the runtime** (`SC-POL-023`). An agent reporting "all tests pass" is an assertion, and assertions do not satisfy gates.

---

## 2. Test Strategy

Defined per project at PLANNING (`03` §5), recorded as a `TEST` domain decision.

```
TestStrategy {
  project_ref,
  levels_in_scope     : per §3, each IN_SCOPE | NOT_APPLICABLE(reason)
  derivation_rules    : how cases come from requirements/ACs/NFRs
  coverage_targets    : per §6 — expressed against acceptance criteria, not only code
  environments        : where each level runs, and its data policy
  data_strategy       : fixtures, factories, anonymization; never production data
  regression_policy   : what must re-run when what changes
  automation_posture  : what is automated, what is manual, and why
  entry_criteria      : when testing may begin
  exit_criteria       : when testing is complete
  defect_policy       : severity definitions and required dispositions
  flakiness_policy    : detection and handling
  non_testable        : what cannot be tested and how it is otherwise assured
}
```

`non_testable` is **DERIVED** and mandatory. Some obligations genuinely cannot be proven by test (long-term data retention behavior, disaster recovery under real conditions, third-party outage handling in production). Naming them forces an alternative assurance path — review, simulation, monitoring, or an explicit accepted risk — instead of leaving a silent gap that the coverage number conceals.

---

## 3. Test Levels

| Level | Verifies | Derived from | Owner | Typical evidence |
|---|---|---|---|---|
| **Unit** | A unit's logic, including edge and error cases | Implementation + rule | Producer writes, Review checks adequacy | Test run output |
| **Integration** | Collaboration across module boundaries and with the database | Module contracts | QA | Test run output |
| **Contract** | API/interface conformance in both directions | `ModuleContract`, external API specs | QA + Integration Eng | Contract test output |
| **Functional / E2E** | A user journey end to end | `UserJourney`, `Flow`, acceptance criteria | QA | Run output + artifacts |
| **State coverage** | Every state defined in `StateCoverage` renders and behaves | UX state coverage | QA | Per-state evidence |
| **Business rule** | Each `BusinessRule` holds, including its boundaries | `BusinessRule[]` | QA | Per-rule test results |
| **Authorization** | Every role × resource × action pair behaves per the model | `AuthorizationModel` | Security Testing | Matrix test results |
| **Failure path** | Timeouts, errors, partial failure, duplicate delivery, retries | Integration design, `IM-16` | QA + Integration Eng | Failure injection results |
| **Data migration** | Migration applies and reverses; data integrity preserved | `MigrationStrategy` | DB Eng + QA | Apply/reverse output |
| **Accessibility** | Declared conformance obligations | `AccessibilitySpec` | QA (`SC-AGENT-213`) | Automated + traversal evidence |
| **RTL / i18n** | Directional and locale behavior on real content | `RTLRules` | QA | Per-locale evidence |
| **Configuration** | Configurable elements at boundaries; protected rules non-bypassable | `ConfigurationRegister`, `ProtectedRule` | QA | Boundary + bypass attempt results |
| **Performance** | Performance NFRs | `NFR[]` | Performance Eng | Measurements |
| **Security** | Security obligations | `ThreatModel`, `SecurityNFR` | Security Testing | Scan + test results |
| **Regression** | Previously-working behavior still works | Prior test set + change impact | QA | Regression run |
| **Exploratory** | Unknown unknowns | Charter, time-boxed | QA | Session notes + any defects |

Levels 5–13 are frequently absent from conventional test plans and are exactly where governed products fail after launch: undefined states, unenforced rules, authorization gaps, unhandled failure paths, untested migrations, retroactive configuration effects.

**Rule:** each level is `IN_SCOPE` or `NOT_APPLICABLE(reason)`. Silence is not scoping (mirrors `SC-POL-019`).

---

## 4. Test Case Derivation

```
TestCase {
  id, level, derived_from : { requirement | acceptance_criterion | business_rule |
                              NFR | state | threat | defect | exploratory_charter },
  preconditions, steps, expected_result,
  data_requirements, environment, automation_state,
  priority, tags, negative: bool
}
```

### 4.1 Derivation rules

- **TD-1** Every `MUST` requirement's acceptance criteria have at least one case each.
- **TD-2** Every business rule has a positive case, a negative case, and boundary cases where the rule has boundaries.
- **TD-3** Every state in `StateCoverage` has a case.
- **TD-4** Every role × resource × action in the authorization model has a case — both permitted and denied.
- **TD-5** Every fixed defect gets a regression case that failed before the fix (`SC-WF-006`).
- **TD-6** Every external integration has failure-path cases: timeout, error response, malformed response, partial failure, duplicate delivery.
- **TD-7** Negative and boundary cases are required, not optional. A suite with only positive cases proves the happy path exists, which is the least interesting property.
- **TD-8** Cases are authored by `SC-AGENT-211` from requirements, and MUST NOT be authored by reading the implementation. Its context bundle and read scope exclude the implementation (`19` CX-6); qualification `QR-05` determines whether that exclusion is enforced or merely instructed.

### 4.2 Why TD-8 needs enforcing

An AI test author given the code will produce tests that pass, because it derives expectations from behavior. This yields high coverage numbers and near-zero defect detection — the worst possible combination, because it produces confident false assurance. Enforcement: the test-design run's context bundle contains requirements, acceptance criteria and specs, and **does not include the implementation** except where a level genuinely requires it (unit tests). This is a context-construction rule (`19` §4), not an instruction to the model.

---

## 5. Defects

```
Defect {
  id, title, severity, found_in (level, run), found_by,
  reproduction : { preconditions, steps, actual, expected }   # MANDATORY
  evidence_refs[], affected (requirement/feature/artifact refs),
  root_cause : { classification, description } | UNDETERMINED,
  fix_ref, regression_test_ref,
  state : NEW | TRIAGED | ACCEPTED | IN_PROGRESS | FIXED | VERIFIED |
          CLOSED | REJECTED(reason) | DEFERRED(trigger) | DUPLICATE(of),
  disposition_reason
}
```

| Severity | Definition | Disposition |
|---|---|---|
| `CRITICAL` | Data loss/corruption, security exposure, or the core journey is unusable | Must fix before Acceptance; never waived |
| `MAJOR` | A requirement is unmet, or a common path is broken | Fix, or waive with authority + recorded risk |
| `MINOR` | Deviation with a workaround | Fix or defer with a trigger |
| `COSMETIC` | Visual/textual, no functional effect | Backlog |

Rules:

- **DF-1** A defect without reproduction evidence is not a defect record; it is an observation.
- **DF-2** `FIXED` is not `VERIFIED`. Verification requires re-execution with captured evidence by someone other than the fixer.
- **DF-3** Root cause is recorded, or explicitly `UNDETERMINED`. "Fixed by rewriting that part" is not a root cause and is a Governance finding.
- **DF-4** Every fix has a regression test that failed before it (TD-5).
- **DF-5** Defect patterns feed `SC-DEPT-064`. Three defects of the same class is a process signal, not three tickets.

---

## 6. Coverage

Serva Code treats **requirement coverage as primary** and code coverage as secondary and diagnostic only.

| Metric | Meaning | Use |
|---|---|---|
| **Acceptance criteria coverage** | AC with ≥1 executed passing case ÷ total AC | Primary; gate criterion |
| **Requirement coverage** | Requirements with all AC covered ÷ total | Primary; Acceptance criterion |
| **Business rule coverage** | Rules with positive+negative+boundary cases | Gate criterion |
| **State coverage** | Defined states with a case | Gate criterion |
| **Authorization matrix coverage** | Role×resource×action pairs tested | Security gate criterion |
| **Failure path coverage** | Integration failure modes tested | Gate criterion |
| **Code coverage** | Lines/branches executed | Diagnostic only — never a gate criterion |

**Why code coverage is not a gate criterion:** it is trivially inflatable and measures execution, not verification. A suite that executes every line while asserting nothing meaningful reports high coverage and proves nothing. Requirement-side coverage cannot be inflated without actually deriving cases from requirements. Code coverage remains useful for finding *untested regions* — that is a diagnostic use, and it is recorded as one.

---

## 7. Test Execution and Evidence

Execution is performed by the runtime through a tool, and the output is captured directly (`SC-POL-023`).

```
TestRun {
  id, strategy_ref, level, test_case_refs[],
  environment : { description, versions, configuration digest }
  command, exit_code, started_at, ended_at,
  results : [ { case_ref, outcome: PASS|FAIL|SKIP|ERROR, duration, message } ]
  raw_output_ref, artifacts (screenshots, logs, reports),
  artifact_versions_covered[],       # input to validity derivation — 31 §3.2
  evidence_ref
}
```

Rules:

- **TE-1** A `TestRun` without a captured exit code and raw output is not evidence.
- **TE-2** `SKIP` counts as not-executed. A suite with skipped cases covering a gate criterion yields `NOT_VERIFIED` for that criterion.
- **TE-3** The environment is recorded. Results from incomparable environments are not comparable, which matters most for performance.
- **TE-4** `artifact_versions_covered` binds the run to what it tested. A change to any of those artifacts makes the result derive to `STALE` (`31` §3.2); nothing is mutated on the run record.
- **TE-5** Flaky tests (non-deterministic outcomes across runs) are **defects in the test suite**, tracked and fixed. A quarantined flaky test does not count toward coverage, and a suite with unquarantined flakiness cannot produce a trustworthy PASS.

---

## 8. QA Process

```
1  Strategy check      levels scoped; entry criteria met
2  Case derivation     from requirements/ACs/rules/states/threats (TD-8 context rule)
3  Case review         coverage against criteria; negative and boundary presence
4  Environment prep    recorded configuration and data
5  Execution           runtime-captured
6  Result analysis     failures triaged into defects vs. test defects
7  Defect recording    with reproduction evidence
8  Regression          scoped by change impact
9  Coverage report     requirement-side metrics
10 Verdict             ArtifactVerifierResult (31 V3b), with dimensions checked
                       and dimensions NOT checked plus reasons
```

### 8.1 QA verdict rules

The QA verdict is an **`ArtifactVerifierResult`** (`31` V3b, schema in `16` §5) with `role = QA`. It has no vocabulary of its own.

| Value | Conditions |
|---|---|
| `PASS` | All in-scope levels executed; no open `CRITICAL`/`MAJOR` defect; coverage targets met; no unquarantined flakiness; all evidence derives to `VALID`; every dimension on a `MEASURED` or `DERIVED` basis |
| `PASS_WITH_QUALIFICATION` | As `PASS`, but a coverage dimension rests on a judged-basis assessment, or an active waiver covers a shortfall |
| `FAIL` | Any open `CRITICAL`/`MAJOR` defect, or a coverage target unmet |
| `NOT_VERIFIED` | A scoped level was not executed, evidence is absent or derives to non-`VALID`, or a runtime component was unavailable |
| `BLOCKED` | The build under test or a required environment did not exist |

**`NOT_VERIFIED` is the default when in doubt.** The most valuable property of this whole model is that "we didn't check" is reportable, distinguishable from "we checked and it's fine", and cannot be quietly rendered as `PASS`.

`ESCALATED` is **not** available (`31` AV-1); an escalating QA run produces a `RunOutcome` of `ESCALATED` and no verifier result.

A `NOT_VERIFIED` or `BLOCKED` QA result MUST carry a `cause` (`31` §4.3) so the gate criterion it feeds inherits the right `INDETERMINATE` reason (`31` §4.4 MV-3, MV-4). Reporting "not verified" without saying **why** would collapse three different remedies into one.

---

## 9. Test Data

- **TDA-1** Production data MUST NOT be used in non-production environments. If realistic data is required, it is generated or anonymized, and the anonymization is verified.
- **TDA-2** Test data is reproducible — fixtures or factories under version control, not hand-made state.
- **TDA-3** Test data containing anything resembling real credentials or personal data is a security finding.
- **TDA-4** Data setup and teardown are part of the case; tests that depend on leftover state from other tests are defects (a leading cause of flakiness).

---

## 10. Regression Policy

Scoped by change impact rather than run-everything-always, because unbounded regression is the main driver of assurance cost.

| Change | Regression scope |
|---|---|
| Localized implementation change | Affected module tests + its consumers' contract tests |
| Contract change | All consumers |
| Schema change | Data access, migration, and dependent business rules |
| Design token change | Visual regression across all consumers (`SC-WF-013`) |
| Business rule change | That rule's cases + processes containing it |
| Configuration classification change | Configuration tests + affected feature |
| Dependency update | Full suite of affected surface + security scan |
| Security fix | Security suite + affected functional area |
| Pre-release | Full suite |

Impact-driven scoping is computed from the link graph (`08` Q14) — not estimated by an agent.

---

## 11. Failure Modes

| ID | Failure | Countermeasure |
|---|---|---|
| `QA-1` | Tests written from the implementation | TD-8 context rule (`19` §4) |
| `QA-2` | Asserted test results | `SC-POL-023`; runtime capture only |
| `QA-3` | High code coverage, low defect detection | Requirement-side coverage is the gate metric |
| `QA-4` | Only happy paths tested | TD-7; negative/boundary mandatory |
| `QA-5` | Flaky tests tolerated | TE-5; flakiness is a defect class |
| `QA-6` | Defect closed without verification | DF-2; verifier ≠ fixer |
| `QA-7` | Skipped tests counted as passed | TE-2 |
| `QA-8` | Non-`VALID` results authorizing a release | TE-4 + `SC-POL-031` + `31` §3.2 |
| `QA-9` | Missing failure-path tests for integrations | TD-6; `IM-16` |
| `QA-10` | Authorization gaps | TD-4 matrix coverage |
| `QA-11` | Accessibility claimed from automated checks alone | `13` §5.3 honesty rule |
| `QA-12` | Untested migrations | Migration level mandatory when schema changes |
| `QA-13` | Production data in test | TDA-1 |
| `QA-14` | "Non-testable" gaps hidden by coverage numbers | `non_testable` mandatory in strategy |
