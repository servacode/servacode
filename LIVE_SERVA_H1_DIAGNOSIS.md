# SERVA CODE — LIVE-SERVA SECOND BLOCK DIAGNOSIS (H1 / SANDBOX_NOT_MEASURED)

The fixture correction worked. The oracle preflight passed, the owner request reached QUEUED,
and the chain then stopped at a **different and previously unseen** block.

This document is derived from the Store, the guest, and direct re-measurement. Nothing is taken
from console prose.

## 1. The exact blocking event

```
SANDBOX_NOT_MEASURED: H1 NO_INDEPENDENT_TRUTH:
the probe ran but nothing on disk decides whether it was contained
```

`src/engineering/sandboxProfile.ts:478-484`

## The causal chain

```
REQUEST      SC-TURN-…  (owner: fix total(), QUEUED)
→ WORK ITEM  SC-WI-01M0TRJK9J001662MZVTM
→ CLASSIFIER SC-RUN-01M0TRJKAB000Z7RAVV0A  (SC-AGENT-003)  COMPLETED
→ PLANNER    SC-RUN-01M0TRM9YG001WG75QERB  (SC-AGENT-001)  COMPLETED
→ SANDBOX PROBE  SC-RUN-01M0TRPER9000DV2BCRN4 (SC-AGENT-150) COMPLETED
→ MEASUREMENT   15 of 16 probes contained; H1 attribution SANDBOX, contained undefined
→ SANDBOX_NOT_MEASURED
→ BLOCKED   (0 ChangeSets, 0 evidence — no Producer was ever dispatched)
```

## 2. Evidence

The sandbox measurement in the fixture Store:

| Probes | permission | reached | attribution | contained |
|---|---|---|---|---|
| R1–R9, W2–W6, N1 (15) | ALLOWED | true | SANDBOX | **true** |
| **H1** | ALLOWED | true | **SANDBOX** | **undefined** |

Compare the same probe in every previous run — `evidence/invalid-live-fixture/store` and
`evidence/LIVE_ENGINEERING_RUN.txt`:

```
H1 | reached true | attribution ENVIRONMENT | contained undefined
   | HOST_ESCAPE_CURRENTLY_BLOCKED_BY_ENVIRONMENT — measured OUTSIDE the sandbox: EXIT=126
```

H1 was **always** undecidable. What changed is its *attribution*.

## Why the attribution changed

`hostEscapeRunsUnsandboxed` (`src/engineering/osQualification.ts:526-565`) runs the host-escape
command in the guest **without** a sandbox and asks whether it works there. If it does not, H1 is
attributed to the ENVIRONMENT and skipped; if it does, H1 is real SANDBOX evidence and its
verdict must be decidable.

Re-measured directly, five consecutive times:

```
attempt 1..5: runs=true | out="hi EXIT=0"
```

Previously that command exited **126**. `grep -o "EXIT=[0-9]*"` over the earlier engineering run
returns exactly one value: `EXIT=126`.

The guest confirms why. `/etc/wsl.conf` contains no `[interop]` section, so interop defaults to
enabled, and `WSLInterop` is registered in `/proc/sys/fs/binfmt_misc/`:

```
[boot]
command = ip link set dev eth0 mtu 1400

[user]
default=servatest
```

**Windows interop is now working in the guest where it previously was not.** `serva machine
doctor` reports `Windows interop......... READY`.

## 3. Classification

**B. ENVIRONMENT_BLOCK** — with the caveat that this is Serva *correctly* refusing.

The machine's containment posture genuinely changed between runs. H1 stopped being an
environmental non-event and became a live host-escape probe whose containment this instrument
cannot independently decide, so Serva refused to call the sandbox measured.

It is **not** C (product defect): the adjudicator is behaving exactly as designed. It is not D:
the fixture is now correct and the preflight proves it. It is not A: no gate or owner authority
was involved.

## 4. Serva behaved correctly

This is the qualification transport invariant reaching the OS-sandbox layer:

> a probe that ran but whose containment nothing on disk decides is **NOT_MEASURED**,
> never "contained".

Serva refused to dispatch a Producer on an unproven boundary. Fifteen contained probes did not
buy the sixteenth a pass. **A measurement that had accepted `contained: undefined` as containment
would be the defect** — and would be exactly the class of failure this whole phase has been
correcting.

No ChangeSet, no Producer run, no model spend beyond classification and planning.

## 5. Must source code change?

**No.** Every component behaved correctly. Changing the adjudicator to tolerate an undecidable
H1 would weaken a security boundary to make an acceptance green, which is forbidden and would be
wrong regardless.

## 6. Must fixture truth change?

**No.** The fixture is correct and its oracle is proven eligible.

## 7. Owner action required?

**Yes — and only the owner can decide it.**

Windows interop is enabled in the WSL guest. That is a containment-relevant property of the
machine, and it is the reason H1 is now a live probe. Two honest paths exist, and choosing
between them is the owner's call, not Serva's and not mine:

**(a) Disable interop in the guest** — restoring the posture every earlier run measured, in which
H1 is an environmental non-event. This is what Serva's own documentation recommends
(`serva machine bootstrap` → *"Leave Windows interop disabled in /etc/wsl.conf"*), and it
strengthens containment. It requires editing `/etc/wsl.conf` and restarting the distribution.

**(b) Leave interop enabled** and accept that this machine currently cannot produce a HARD
Producer qualification, because a host-escape probe's containment cannot be independently
decided here.

I have not done either. §7 of the instruction forbids me from changing WSL configuration, and
this is precisely the kind of security-posture decision that must not be made to turn a test
green.

## 8. Machine action required?

Yes, if the owner chooses (a). The exact commands, to be run **by the owner** in the guest:

```
sudo tee -a /etc/wsl.conf >/dev/null <<'EOF'

[interop]
enabled = false
appendWindowsPath = false
EOF
```

then, from Windows:

```
wsl --shutdown
```

Serva will not do this. It is the owner's machine and the owner's security posture.

## 9. Resume

After the owner acts:

```
npm run build
SERVA_PRESERVE_LIVE=1 npm run test:serva-chain
```

The chain restarts from a fresh pre-seed — the current fixture Store has no ChangeSet, no
Producer run and no accepted commit, so there is nothing to resume into.

## 10. Minimal next action

Return **SERVA CODE — OWNER ACTION REQUIRED** and stop. No source change, no fixture change, no
WSL change, no minting.
