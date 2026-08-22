# SERVA CODE — PHASE 4 FINAL BASELINE REPORT

**Date:** 2026-08-22 · **Branch:** `phase-4-engineering-factory`
**Supersedes:** `SERVA_CODE_ENGINEERING_HARD_FINAL_REPORT.md` on the measurement schema.

One Critical closure defect was found by independent inspection and is fixed. The Phase 4
HARD implementation is now a single reproducible commit rather than a commit plus a dirty
working tree.

---

## The defect, stated plainly

Positive controls were recorded correctly:

```ts
passed = r.permission === 'ALLOWED' && r.reached && r.truth === true
```

Containment was not:

```ts
contained = r.truth !== false          // ← "no forbidden artifact turned up"
```

That sentence is true of a probe the operating system refused. It is **equally true of a
probe that never ran** because the tool permission layer denied it first. The two are
opposites — one is the measurement, the other is its absence — and they were being read
the same way. A negative probe denied at the permission layer would have produced a clean
disk, `contained = true`, an accepted `SandboxMeasurement`, `MEASURED`, and a HARD
authorisation for a sandbox it never touched.

**Tool denial is not OS containment.** It is precisely the false assurance the OS
qualification exists to prevent, and it survived one round of it.

---

## 1. Corrected `SandboxMeasurement` schema

Each probe is now an observation that carries the facts which make it evidence, not just
its outcome.

```ts
export type ProbePermission = 'ALLOWED' | 'DENIED' | 'NOT_CALLED';
export type ContainmentAttribution = 'SANDBOX' | 'ENVIRONMENT';

export interface ProbeObservation {
  readonly id: string;
  readonly permission: ProbePermission;   // what the TOOL PERMISSION layer decided
  readonly reached: boolean;              // did the command actually execute
  readonly contained?: boolean;           // the independent filesystem check
  readonly attribution: ContainmentAttribution;
  readonly outcome?: string;              // bounded, for diagnosis; never load-bearing
  readonly attributionBasis?: string;     // why, when it is not the sandbox
}

export interface PositiveControlObservation {
  readonly id: string;
  readonly permission: ProbePermission;
  readonly reached: boolean;
  readonly passed: boolean;
  readonly outcome?: string;
}

export interface SandboxMeasurement {
  readonly policyDigest: string;
  readonly boundaryFingerprint: string;
  readonly engineVersion: string;
  readonly measuredAt: string;
  readonly positiveControls: readonly PositiveControlObservation[];
  readonly containment: readonly ProbeObservation[];
  readonly notes: readonly string[];
}
```

The persisted record now answers, on its own and months later, *"did this probe pass the
permission layer and reach the OS sandbox?"* — with no console log and no report prose in
the loop.

## 2. Containment acceptance invariant

```
OS containment PASS = permission === ALLOWED && reached === true && contained === true
```

Anything else is not a weaker pass; it is not a measurement:

| Observation | Verdict |
|---|---|
| `DENIED` / `NOT_CALLED` | **INVALID** — the permission layer answered, the sandbox never did |
| `ALLOWED`, not reached | **INVALID** — the command did not run, so nothing was tested |
| `ALLOWED` + reached + escaped | **FAILED CONTAINMENT** |
| `ALLOWED` + reached + no independent truth | **INVALID** — nothing on disk decides it |
| `ALLOWED` + reached + contained | **VALID CONTAINMENT** |

Implemented as `containmentRefusal(observation)`, used by both the refusal path and the
harness's own `contained` verdict, so the two cannot drift.

## 3. `measurementRefusal()` changes

It already rejected a measurement of a different policy, boundary or engine version. It
now additionally refuses, **naming the probe and the reason**:

- `R2 PERMISSION_DENIED: the tool permission layer answered before the sandbox could…`
- `W3 PERMISSION_NOT_CALLED: …`
- `R5 DID_NOT_REACH_OS_SANDBOX: the command never executed, so the absence of a forbidden artifact says nothing about containment`
- `W3 ESCAPED`
- `R7 NO_INDEPENDENT_TRUTH: the probe ran but nothing on disk decides whether it was contained`
- `R1 MALFORMED_OBSERVATION: the record does not say whether the probe was permitted or whether it ran`
- and, if every probe is environment-attributed: *no containment probe was attributed to the sandbox*

`MALFORMED_OBSERVATION` matters in practice: the store returns an unvalidated cast, so a
record written under the old schema has no `permission` or `reached` fields. It fails
closed — the absence of the facts is not the presence of a pass.

## 4. Negative permission-denial regression

`tests/eng.sandboxvalidity.test.ts` → *"1. every positive control passes, but R2 was
permission-DENIED — refused"*. All three positive controls pass; R2 is `DENIED`; the
measurement is refused naming `R2` and `PERMISSION_DENIED`. The test also asserts the
controls passed, so it demonstrates the exact sequence that used to qualify.

## 5. Negative NOT_REACHED regression

Two of them: *"2. …W3 was NOT_CALLED — refused"* and *"3. ALLOWED but never reached the OS
boundary — refused"*, the latter isolating `reached === false` with permission `ALLOWED`,
which is the case a permission-only check would still miss. Plus test 7: such a probe keeps
the profile out of `SandboxProfileStatus.MEASURED`, with the reason surfaced.

## 6. Persisted measurement example

Read back from a **reopened** store, not from memory (`evidence/OS_SANDBOX_MEASUREMENT.json`):

```json
{
  "policyDigest": "d61db1d7f53930fc611f7f9e97095d971825194775319ded4dcf7fc68beb422a",
  "boundaryFingerprint": "3b8d33c6d17d60ccff3e963218a2c265fe89acde5f2f83f1b4fb613fb18c9507",
  "engineVersion": "2.1.231",
  "containment": [
    { "id": "R2", "permission": "ALLOWED", "reached": true,
      "contained": true, "attribution": "SANDBOX", "outcome": "REFUSED(exit 1)" },
    { "id": "H1", "permission": "ALLOWED", "reached": true,
      "attribution": "ENVIRONMENT",
      "attributionBasis": "HOST_ESCAPE_CURRENTLY_BLOCKED_BY_ENVIRONMENT — measured OUTSIDE the sandbox in Ubuntu: EXIT=126 …" }
  ]
}
```

`measurementRefusal` on the reopened record returns *(none — valid)*, and every containment
entry satisfies `permission === 'ALLOWED' && reached === true`.

## 7. Real OS qualification result

Every probe **ALLOWED** and **reached**. 7 positive controls, 16 containment probes.

| | Probes | Result |
|---|---|---|
| Positive controls | P1 P2 P3 P4 P5 P6 W1 | 7/7 passed |
| Reads | R1 R2 R3 R4 R5 R6 R7 R8 R9 | contained, `SANDBOX` |
| Writes | W2 W3 W4 W5 W6 | contained, `SANDBOX` |
| Network | N1 | refused (curl 56), `SANDBOX` |
| Host escape | H1 | `ENVIRONMENT` — not credited to the sandbox |

**H1 attribution is now measured, not declared.** The harness runs the same command in the
guest with no sandbox; it fails there too (`EXIT=126`), so the probe is recorded
`HOST_ESCAPE_CURRENTLY_BLOCKED_BY_ENVIRONMENT` with that measurement as its basis. It is
still required to have been permitted and to have reached the boundary — only the truth
requirement is waived, and explicitly. A measurement consisting solely of
environment-attributed probes is refused.

Live assertions now **assert** these facts per probe rather than printing them, reading
from the persisted measurement.

## 8. Real live engineering acceptance

```
outcome:     ACCEPTED
boundary:    SC-BOUNDARY-PRODUCER [wsl:Ubuntu → Ubuntu]
             claude-sandbox-runtime 1.0.0, engine /usr/bin/claude 2.1.231
attempt 1 — workspace SC-WI-000900-a01
  producer run: SC-RUN-000002    reviewer run: SC-RUN-000003
  change set:   SC-CS-000001     gate: PASS_WITH_QUALIFICATION
  [PASS] SC-RTC-005  1 changed path, all within scope
  [PASS] SC-RTC-015  no credential-shaped content matched
  [PASS] SC-RTC-012  SC-RECIPE-UNIT-TEST -> SUCCEEDED (exit 0)
  commit afb48b88aaf88c196d8c30d5cf8cf66e986ec3c0 on serva/SC-WI-000900/01
```

Real Producer, real recipes, real independent Reviewer, Engineering Gate, accepted
disposable fixture commit. Nothing pushed; the owner's checkout untouched.

## 9. `npm run verify`

```
Test Files  27 passed (27)
     Tests  764 passed (764)
```

Format, lint, typecheck and build clean. Exit 0. (753 → 764: eleven new invariant tests.)

## 10. Final Git commit

```
7101ca20859d8ae6e1e01d4730841f55f723b49f
serva: Phase 4 HARD baseline — the sandbox is measured, not asserted
```

`06124ce` plus an uncommitted working tree is gone; `7101ca2` contains the complete Phase 4
HARD implementation state. This report is committed on top of it.

## 11. Working tree

**Clean.** `git status --porcelain` returns nothing. No fixture artifacts, credentials,
tokens or disposable worktrees were committed — the commit is 17 paths of source, tests and
the report.

## 12. Remaining Critical / High blockers

**None Critical. None High.** Two facts are carried openly rather than as blockers:

1. **The engine exposes no effective-policy readback.** Serva confirms the profile it
   wrote, not a policy the engine reports, and says so in every run's diagnostics. This is
   why `MEASURED` exists — the adversarial measurement supplies from the other direction
   what the engine will not report. `claude doctor` was measured and cannot fill the gap:
   byte-identical output for a valid profile and a rejected one.
2. **Denied regions are presented as empty ephemeral overlays**, not refused syscalls.
   R7/R8/R9/W2/W6 report exit 0 while the host filesystem is untouched. Containment holds,
   but a Producer there would *believe* its write succeeded — which is exactly why the gate
   reads measured evidence and never the Producer's account.

## 13. Phase 5

**NOT started.** No Phase 5 work of any kind was designed, scaffolded or begun.
