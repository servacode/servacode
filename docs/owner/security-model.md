# Security model

## Local, single-owner, private

Serva runs on your computer. There is no server, no account, no telemetry and no cloud
control plane. Your project does not leave this machine unless you send it somewhere.

## What an agent can do

Very little, deliberately.

A company-intelligence agent — the ones that research, specify, design and decide — has **no
tools at all**. It reads the context Serva assembled and returns structured output. No
filesystem, no commands, no network.

A code-writing agent runs inside a Linux guest, inside a sandbox, in an isolated copy of the
repository. It cannot reach your Windows files, cannot reach the network, and cannot commit.

## Retrieval

When research is needed **Serva** fetches, not the agent. The page is captured, digested and
handed over as UNTRUSTED data.

Anything a page says — including text shaped like an instruction — is analysed and never
obeyed. That is structural rather than a rule the model is asked to follow: retrieved
content enters the untrusted region of the prompt, and the agent reading it has no network
or filesystem capability to act on it with even if it wanted to.

Nothing about your project is sent outward to answer a research question.

## Research is not fact until it is checked

A finding by the researcher is a claim. A separate verifier — which cannot re-fetch, and
may not be the actor that made the claim — checks it against the captured source. Only a
supported claim becomes something another department may build on.

## What Serva refuses

- An agent answering a question that is yours to answer.
- An agent approving its own work, or accepting its own proposal.
- A gate passing on absent evidence.
- Write-capable engineering on an unmeasured machine.
- A credential in a backup.
- A restore that would silently overwrite a different project.
- A release nobody authorised.

## What Serva cannot promise

It cannot promise a model will never be wrong. What it promises is that a wrong answer
cannot become project truth without evidence, cannot approve itself, and cannot act outside
a capability boundary that was computed before it ran.
