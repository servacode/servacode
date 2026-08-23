# SERVA CODE 1.0 — SECURITY REVIEW

**Independent reviewer:** *none recorded.*

That line is the finding, and it is deliberately the first one. This review was written by
the same actor that wrote the implementation, in the same session. It is a **self-review**,
and §61 of the Phase 6 package says plainly that such a thing may not certify itself.

`serva acceptance` enforces this rather than trusting the reader to notice: the
Security Acceptance line requires a **recorded** independent reviewer, so with none present
it reports `NOT_VERIFIED`, and the overall status refuses to print `READY FOR OWNER USE`.

Nothing below should be read as clearance. It is a map of what was built, what threatens
it, and which deterministic tests hold each control — which is exactly what an independent
reviewer needs in order to do the review that has not happened.

---

## 1. What this system can do, which is why it is worth attacking

Serva reads and writes a project's governed truth, dispatches a code-writing agent inside a
sandbox on the owner's machine, records decisions attributed to the owner personally, and
restores whole project trees from files that came from elsewhere. Any one of those is worth
subverting. Together they make a local process with more authority over the owner's work
than most software they run.

## 2. Threat surface, control, and the test that holds it

### 2.1 An agent acting outside its authority

| Threat | Control | Test |
|---|---|---|
| An agent writes canon belonging to another agent | `ScopedCanonWriter` refuses **before** staging; no `commit` is exposed | `tests/intel.writeauthority.test.ts` |
| An agent answers a question that is the owner's | `ownerDecisionRefusal` at write and at every read; `SC-AGENT-`/`SC-RUN-` prefixes refused | `tests/intel.governance.test.ts`, `tests/services.test.ts` |
| An agent approves its own work | `independentOf` refused at dispatch AND on context provenance | `tests/intel.authority.test.ts` |
| An agent accepts its own proposal | `acceptanceRefusal` requires a typed ruling by an owning authority that is not the proposer | `tests/intel.proposalruling.test.ts` |
| An agent mints the form of consent | `RESERVED_PURPOSES` refused for every department | `tests/intel.governance.test.ts` |
| An agent authorises a release | `RL-1` is a Store query with no verifier role that could satisfy it | `tests/coverage.test.ts`, `tests/services.test.ts` |

**Residual.** Authority is enforced per artifact family. A department authorised for a
family can write anything *within* it, including nonsense. Nonsense is what gates and
independent verifiers are for; the write boundary is about WHO, not about quality.

### 2.2 Prompt injection from retrieved content

| Threat | Control | Test |
|---|---|---|
| A fetched page issues instructions | Content enters the ContextBundle as `UNTRUSTED`, structurally, and is fenced with a digest-derived marker it cannot close | `tests/intel.researchtrust.test.ts` |
| A department launders a capture into trusted context | The runner **refuses** any element whose source names a stored `SourceCapture` and is not UNTRUSTED — checked against the Store, not a name | `tests/intel.researchtrust.test.ts` |
| An injected instruction causes an action | The reader has **no tools at all**: no filesystem, no execution, `network: 'NONE'`, `maxToolCalls: 0` | `tests/intel.researchtrust.test.ts` |
| Unverified research becomes another department's fact | A separate SC-AGENT-063 verifies against the capture; only authoritative verdicts discharge an obligation | `tests/intel.obligations.test.ts` |

**Residual.** Trust marking reduces the probability that a model complies; it does not make
compliance impossible. The actual protection is the capability boundary, and that is why
the capability grant is computed **before** retrieval rather than after.

### 2.3 The engineering sandbox

| Threat | Control | Test |
|---|---|---|
| Write-capable work on an unmeasured machine | HARD is required, and derives from a fingerprint over distro, kernel, guest user, engine binary, sandbox mechanism, its settings and interop | `tests/eng.binding.test.ts`, `tests/portability.test.ts` |
| A qualification outliving what it described | Any fingerprint field changing invalidates it automatically | `tests/portability.test.ts` |
| A qualification inherited from another computer | Machine-bound families are excluded by the writer AND refused by the reader; a restored record carries `restoredFromBackup` and is refused even when it says HARD | `tests/portability.test.ts`, `evidence/PORTABILITY_WALKTHROUGH.txt` |
| An agent opinion passing a failed check | Deterministic checks are the evidence authority; the gate reads evidence, not summaries | `tests/eng.factory.test.ts` |

**Residual.** Serva measures the sandbox; it does not audit bubblewrap or the kernel. A
vulnerability in the containment mechanism is outside what any qualification can detect.

### 2.4 The VS Code extension — the newest and largest attack surface

| Threat | Control | Test |
|---|---|---|
| A forged webview message causes an action | Dispatch is by exact id against a fixed table; there is no path from a message to a function name | `tests/extension.test.ts` |
| A forged message skips confirmation | Consequential actions refuse without explicit confirmation; **destructive** ones additionally require a native modal a page cannot fabricate | `tests/extension.test.ts`, `extension/src/extension.ts` |
| A page chooses a filesystem destination | Destructive actions are not in `WEBVIEW_INVOCABLE` at all | `tests/extension.test.ts` |
| Project content becomes markup | One escaping path, all five characters, no interpolation that bypasses it | `tests/extension.test.ts` |
| An escaping mistake becomes execution | CSP: `default-src 'none'`, one nonce, no `unsafe-inline`, no `unsafe-eval`, no remote origin, `connect-src 'none'` | `tests/extension.test.ts` |
| The panel builds HTML from project text | `panel.js` contains no `innerHTML`, no `eval`, no `document.write` — asserted with comments stripped | `tests/extension.test.ts` |
| Activation in a workspace the owner has not trusted | `untrustedWorkspaces.supported: false` | `tests/extension.test.ts` |

**Residual — and this is the largest one in the package.** The manifest, protocol, renderer
and translations are covered deterministically. **Activation inside a running VS Code
window is not executed by this suite.** A defect that exists only in the wiring — a message
handler registered twice, a panel retaining a stale runtime — would not be caught here. §52
asked for extension integration tests using the VS Code test harness; they are not present.

### 2.5 Backup and restore — hostile input

| Threat | Control | Test |
|---|---|---|
| Path traversal from a manifest | Every path normalized, checked, and re-checked after resolution | `tests/portability.test.ts` |
| Symlink traversal | Links are recorded and **not followed**, on write and on read | `tests/portability.test.ts` |
| Archive bomb | Entry count, total bytes and per-file bytes are capped | `src/portability/backup.ts` |
| A tampered manifest | The manifest carries a digest over itself; every file carries its own | `tests/portability.test.ts` |
| Smuggled files the manifest never listed | Reported as a verification failure | `tests/portability.test.ts` |
| A rollback attack — an old backup restored over a newer project | Restore refuses an occupied destination without explicit confirmation, and moves displaced contents aside rather than deleting | `tests/portability.test.ts` |
| A backup from a newer Serva | Refused outright rather than read partially | `tests/portability.test.ts` |
| Credential leakage | Excluded by path AND by content scan at write; re-checked at verify | `tests/portability.test.ts`, `evidence/PORTABILITY_WALKTHROUGH.txt` |
| An attacker-controlled `.serva` restored | Machine-bound families refused on the way in; the Store verifies its own digests on read | `tests/portability.test.ts` |

**Residual.** The credential scanner is a deny-list and cannot be complete. Its job is to
make a mistake loud, not to be a proof. A determined owner can still put a secret in a file
shaped unlike any known credential.

**No archive parser was added.** The bundle is a directory plus a manifest, read with the
same confinement rules the Store uses, precisely because the one code path that consumes
attacker-influenced input is the worst place to add an unaudited tar or zip implementation.

### 2.6 Cross-project isolation

| Threat | Control | Test |
|---|---|---|
| One client's material reaching another | The leakage wall refuses paths, URLs, emails, instance ids, credentials and code — on contribution AND again on publication | `tests/library.test.ts` |
| Identity leaking as metadata | An entry records kind, time and a **content** digest. Never the project, client or directory | `tests/library.test.ts` |
| Learning enabled without the owner deciding | Off by default; a disabled library reads and writes nothing at all | `tests/library.test.ts` |
| Prior success used as authority | A library entry becomes a CANDIDATE; `applyPattern` refuses without an independent ApplicabilityAssessment | `tests/intel.governance.test.ts` |

**Residual.** The wall is pattern-based. Writing the library exposed three shapes it had
been missing — a forward-slash Windows path, an instance artifact id, inline backticked
code — which suggests there are others. Refusing rather than redacting limits the damage: a
sentence that slips through is one somebody wrote as a generalisation, not a redacted
client fact.

### 2.7 Owner authority

| Threat | Control | Test |
|---|---|---|
| A decision recorded without a person | Agent-prefixed answers refused at write and at read | `tests/intel.governance.test.ts` |
| A free-text answer to an option question, or a meta-answer to a value question | `answerRefusal` at the point a person types it | `tests/intel.ownervalue.test.ts` |
| An approval reused for a different target | `approvalRefusal` binds purpose AND exact target | `tests/intel.governance.test.ts` |
| A release shipped on a recommendation | `RR-OWNER-AUTHORITY` requires an owner decision; a recommendation is advice | `tests/services.test.ts` |

## 3. What this review cannot establish

1. **That it is independent.** It is not. See the first line.
2. **That the extension behaves correctly inside VS Code.** Not executed.
3. **That the containment mechanism is itself sound.** Serva measures bubblewrap; it does
   not audit it.
4. **That the credential deny-list is complete.** It cannot be.
5. **That the leakage wall catches every shape.** Three were found while writing one
   feature.
6. **That no defect exists in code this review did not read.** A self-review reads what its
   author remembers writing, which is the specific weakness independence exists to remove.

## 4. What an independent reviewer should attack first

In the order I would attack it:

1. **The extension's runtime wiring** — the one place with authority and no execution
   coverage.
2. **The leakage wall** — pattern-based, newly load-bearing, and three misses found in one
   sitting.
3. **The restore path** — it writes whole trees from external input, and the confinement is
   my own code checking my own manifest.
4. **`ScopedCanonWriter`'s callers** — the boundary is sound; every `persist` that goes
   through it is a place to look for one that does not.
5. **The credential scanner's blind spots** — specifically, what a real project puts in a
   file that no pattern here names.

---

**Status: NOT INDEPENDENTLY REVIEWED.** `serva acceptance` reports `Security Acceptance:
NOT_VERIFIED` and refuses `READY FOR OWNER USE` on that basis, which is the correct
behaviour and not a defect to be worked around.
