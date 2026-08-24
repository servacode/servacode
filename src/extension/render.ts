import { Direction, Language, contentDirection, directionOf, t } from './i18n.js';
import { ConditionState, ReleaseReadinessStatus } from '../intelligence/releaseReadiness.js';
import { ProjectHealth } from '../app/services.js';
import { MachineQualificationState } from '../portability/machine.js';
import type { MessageKey } from './i18n.js';
import type { ProjectSnapshot } from '../app/services.js';
import type { ConversationTurn } from '../app/conversation.js';

/**
 * THE CONTROL CENTER, RENDERED.
 *
 * SPEC: §5, §6, §7, §36, §37, §47.
 *
 * A webview renders content that came out of a project directory. Requirement text, a
 * defect title, a research finding, an owner's own words — all of it authored elsewhere,
 * some of it retrieved from the internet, and every bit of it about to become HTML.
 *
 * So there is exactly one way text reaches the page, and it escapes. Not "usually
 * escapes": the renderer has no interpolation path that does not, and the Content Security
 * Policy means that even a mistake here cannot execute — no inline script, no remote
 * origin, one nonce for one script Serva wrote.
 *
 * The layout is mirrored rather than flipped. Logical properties throughout, so an Arabic
 * interface moves the furniture and not only the words — and technical content keeps its
 * own direction, because a file path is not an Arabic sentence and does not become one by
 * appearing in an Arabic interface.
 */

/**
 * Escape text for HTML.
 *
 * All five characters, including the quotes, because this is used inside attributes as
 * well as between tags and a partial escape is the kind that works in every test somebody
 * wrote and fails on the input somebody did not.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A span of untrusted text, escaped and carrying the direction it should read in. */
export function text(value: string, language: Language): string {
  const dir = contentDirection(value, language);
  return (
    '<span dir="' +
    dir +
    '"' +
    (dir === Direction.LTR && directionOf(language) === Direction.RTL ? ' class="technical"' : '') +
    '>' +
    escapeHtml(value) +
    '</span>'
  );
}

/**
 * The Content Security Policy.
 *
 * Everything is denied and then one thing is allowed: a single script carrying the nonce
 * Serva generated for this render. No `unsafe-inline`, no `unsafe-eval`, no remote origin,
 * and no image or font from anywhere but the extension's own directory.
 *
 * This is the reason an escaping mistake is a display bug rather than a compromise.
 */
export function contentSecurityPolicy(nonce: string, cspSource: string): string {
  return [
    "default-src 'none'",
    'img-src ' + cspSource,
    'style-src ' + cspSource,
    'font-src ' + cspSource,
    "script-src 'nonce-" + nonce + "'",
    "form-action 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
  ].join('; ');
}

const HEALTH_KEY: Readonly<Record<string, MessageKey>> = Object.freeze({
  [ProjectHealth.ACTIVE]: 'status.active',
  [ProjectHealth.OWNER_ACTION]: 'status.ownerAction',
  [ProjectHealth.BLOCKED]: 'status.blocked',
  [ProjectHealth.ENGINEERING]: 'status.engineering',
  [ProjectHealth.UNQUALIFIED]: 'status.unqualified',
  [ProjectHealth.DIVERGENCE]: 'status.divergence',
  [ProjectHealth.RECOVERY_REQUIRED]: 'status.recoveryRequired',
  [ProjectHealth.NOT_STARTED]: 'status.notStarted',
});

const CONDITION_KEY: Readonly<Record<string, MessageKey>> = Object.freeze({
  [ConditionState.MET]: 'release.conditionMet',
  [ConditionState.NOT_MET]: 'release.conditionNotMet',
  [ConditionState.NOT_VERIFIED]: 'release.conditionNotVerified',
  [ConditionState.NOT_APPLICABLE]: 'release.conditionNotApplicable',
});

const MACHINE_KEY: Readonly<Record<string, MessageKey>> = Object.freeze({
  [MachineQualificationState.HARD]: 'machine.hard',
  [MachineQualificationState.SOFT]: 'machine.soft',
  [MachineQualificationState.UNQUALIFIED]: 'machine.unqualified',
  [MachineQualificationState.BLOCKED]: 'machine.blocked',
});

/** The owner-facing label for a health state, translated. */
export function healthLabel(health: string, language: Language): string {
  const key = HEALTH_KEY[health];
  return key === undefined ? health : t(language, key);
}

/**
 * The status-bar text.
 *
 * Derived from the snapshot every time. There is no "set the status bar green" path,
 * because a status bar that could be set would eventually be set on activation and an
 * owner would read a tick as a governed company.
 */
export function statusBarText(snapshot: ProjectSnapshot, language: Language): string {
  const icon =
    snapshot.health === ProjectHealth.ACTIVE
      ? '$(check)'
      : snapshot.health === ProjectHealth.OWNER_ACTION
        ? '$(person)'
        : snapshot.health === ProjectHealth.BLOCKED
          ? '$(error)'
          : snapshot.health === ProjectHealth.ENGINEERING
            ? '$(tools)'
            : snapshot.health === ProjectHealth.RECOVERY_REQUIRED
              ? '$(warning)'
              : '$(circle-slash)';
  return icon + ' Serva — ' + healthLabel(snapshot.health, language);
}

export interface RenderOptions {
  readonly snapshot: ProjectSnapshot;
  readonly language: Language;
  /**
   * The governed conversation, oldest first.
   *
   * Optional so a caller that only wants the state view is not forced to read it, and so the
   * section renders empty rather than absent when there is nothing to show — an owner who
   * cannot see where to ask has no way to learn that they may.
   */
  readonly conversation?: readonly ConversationTurn[];
  readonly nonce: string;
  readonly cspSource: string;
  readonly styleUri: string;
  readonly scriptUri: string;
}

/**
 * Render the Control Center.
 *
 * One function producing one document, so there is one place where escaping either happens
 * or does not. Assembling fragments across modules is how a component ends up with the
 * only unescaped interpolation in the product.
 */
export function renderControlCenter(o: RenderOptions): string {
  const { snapshot, language } = o;
  const dir = directionOf(language);
  const T = (key: MessageKey): string => escapeHtml(t(language, key));

  const stages = snapshot.stages
    .filter((s) => s.state !== 'NOT_APPLICABLE')
    .map(
      (s) =>
        '<li class="stage stage--' +
        escapeHtml(s.state.toLowerCase()) +
        '">' +
        '<span class="stage__name">' +
        text(s.name, language) +
        '</span>' +
        '<span class="stage__state">' +
        escapeHtml(s.state) +
        (s.verdict === undefined ? '' : ' · ' + escapeHtml(s.verdict)) +
        '</span>' +
        '</li>',
    )
    .join('');

  /*
   * THE CONVERSATION.
   *
   * SPEC: Phase 6 closure §5.
   *
   * Every turn shows what the owner asked, verbatim, and what the COMPANY did with it: the
   * class it was given, the departments queued, or the stage Serva stopped at and why.
   *
   * There is no field here carrying a sentence an agent wrote for the owner to read. That
   * absence is the design: a reply written by a model, shown in a transcript, is a chat
   * surface whatever the code around it is called — and a chat surface has no departments,
   * no gates and no canon it is allowed to write.
   */
  const turns = o.conversation ?? [];
  const conversation =
    turns.length === 0
      ? '<p class="empty">' + T('conversation.empty') + '</p>'
      : '<ol class="turns">' +
        turns
          .map(
            (turn) =>
              '<li class="turn turn--' +
              escapeHtml(turn.outcome.toLowerCase()) +
              '">' +
              '<p class="turn__asked">' +
              text(turn.text, language) +
              '</p>' +
              '<p class="turn__outcome">' +
              escapeHtml(
                turn.outcome === 'QUEUED'
                  ? t(language, 'conversation.queued')
                  : turn.outcome === 'HALTED'
                    ? t(language, 'conversation.halted')
                    : t(language, 'conversation.refused'),
              ) +
              (turn.classification === undefined ? '' : ' · ' + escapeHtml(turn.classification)) +
              '</p>' +
              (turn.queued.length === 0
                ? ''
                : '<ul class="turn__queued">' +
                  turn.queued.map((d) => '<li>' + text(d, language) + '</li>').join('') +
                  '</ul>') +
              (turn.haltReason === undefined
                ? ''
                : '<p class="turn__reason">' + text(turn.haltReason, language) + '</p>') +
              '</li>',
          )
          .join('') +
        '</ol>';

  const ask =
    '<div class="ask">' +
    '<label for="ask-input">' +
    T('conversation.prompt') +
    '</label>' +
    '<textarea id="ask-input" data-ask rows="3" ' +
    'placeholder="' +
    T('conversation.placeholder') +
    '" aria-describedby="ask-hint"></textarea>' +
    '<button type="button" data-ask-submit>' +
    T('conversation.send') +
    '</button>' +
    '<p class="ask__hint" id="ask-hint">' +
    T('conversation.governed') +
    '</p>' +
    '<p class="ask__error" data-ask-error role="alert" hidden>' +
    T('conversation.empty.refusal') +
    '</p>' +
    '</div>';

  const ownerActions =
    snapshot.ownerActions.length === 0
      ? '<p class="empty">' + T('overview.nothingWaiting') + '</p>'
      : snapshot.ownerActions
          .map(
            (a) =>
              '<article class="decision" data-decision="' +
              escapeHtml(a.id) +
              '">' +
              '<h3>' +
              text(a.question, language) +
              '</h3>' +
              (a.blocksWork
                ? '<p class="badge badge--blocking">' + T('owner.blocksWork') + '</p>'
                : '') +
              '<p class="decision__why"><strong>' +
              T('owner.why') +
              ':</strong> ' +
              text(a.whyServaCannotDecide, language) +
              '</p>' +
              '<p class="decision__recommendation"><strong>' +
              T('owner.recommendation') +
              ':</strong> ' +
              text(a.recommendation, language) +
              ' — ' +
              text(a.recommendationRationale, language) +
              '</p>' +
              (a.responseMode === 'VALUE'
                ? /*
                   * A VALUE question needs somewhere to type AND a way to record it. The
                   * first version of this rendered the input alone, with no submit and no
                   * handler in the panel script, so the primary owner surface could not
                   * actually answer the primary kind of blocking question. An input that
                   * goes nowhere reads as a working control, which is worse than no control.
                   *
                   * No meta-option: there is no button here that stands for a value. The
                   * owner types the answer and Serva records exactly that.
                   */
                  '<div class="decision__value">' +
                  '<label for="value-' +
                  escapeHtml(a.id) +
                  '">' +
                  T('owner.enterValue') +
                  '</label>' +
                  '<input type="text" id="value-' +
                  escapeHtml(a.id) +
                  '" data-value-for="' +
                  escapeHtml(a.id) +
                  '" autocomplete="off" spellcheck="false" ' +
                  'aria-describedby="value-hint-' +
                  escapeHtml(a.id) +
                  '" />' +
                  '<button type="button" class="decision__submit" data-value-submit="' +
                  escapeHtml(a.id) +
                  '">' +
                  T('owner.answer') +
                  '</button>' +
                  '<p class="decision__hint" id="value-hint-' +
                  escapeHtml(a.id) +
                  '">' +
                  T('owner.valueHint') +
                  '</p>' +
                  '<p class="decision__error" data-value-error="' +
                  escapeHtml(a.id) +
                  '" role="alert" hidden>' +
                  T('owner.valueRequired') +
                  '</p>' +
                  '</div>'
                : '<ul class="decision__options">' +
                  a.options
                    .map(
                      (opt) =>
                        '<li><button type="button" data-option-for="' +
                        escapeHtml(a.id) +
                        '" data-option="' +
                        escapeHtml(opt.option) +
                        '">' +
                        text(opt.option, language) +
                        '</button><span class="option__impact">' +
                        text(opt.impact, language) +
                        '</span></li>',
                    )
                    .join('') +
                  '</ul>') +
              '</article>',
          )
          .join('');

  const blockers =
    snapshot.blockers.length === 0
      ? '<p class="empty">' + T('common.none') + '</p>'
      : '<ul class="blockers">' +
        snapshot.blockers.map((b) => '<li>' + text(b, language) + '</li>').join('') +
        '</ul>';

  const stale =
    snapshot.staleFacts.length === 0
      ? '<p class="empty">' + T('common.none') + '</p>'
      : '<ul class="stale">' +
        snapshot.staleFacts.map((s) => '<li>' + text(s, language) + '</li>').join('') +
        '</ul>';

  const release =
    '<p class="release release--' +
    escapeHtml(snapshot.release.status.toLowerCase()) +
    '">' +
    escapeHtml(
      t(
        language,
        snapshot.release.status === ReleaseReadinessStatus.READY
          ? 'release.ready'
          : snapshot.release.status === ReleaseReadinessStatus.BLOCKED
            ? 'release.blocked'
            : 'release.notVerified',
      ),
    ) +
    '</p><ul class="conditions">' +
    snapshot.release.conditions
      .map(
        (c) =>
          '<li class="condition condition--' +
          escapeHtml(c.state.toLowerCase()) +
          '"><span class="condition__label">' +
          text(c.label, language) +
          '</span><span class="condition__state">' +
          escapeHtml(t(language, CONDITION_KEY[c.state] ?? 'release.conditionNotVerified')) +
          '</span><span class="condition__detail">' +
          text(c.detail, language) +
          '</span></li>',
      )
      .join('') +
    '</ul>';

  const machine =
    '<p class="machine machine--' +
    escapeHtml(snapshot.machine.state.toLowerCase()) +
    '">' +
    escapeHtml(t(language, MACHINE_KEY[snapshot.machine.state] ?? 'machine.unqualified')) +
    '</p><p class="machine__reason">' +
    text(snapshot.machine.reason, language) +
    '</p>';

  return [
    '<meta charset="utf-8" />',
    '<meta http-equiv="Content-Security-Policy" content="' +
      escapeHtml(contentSecurityPolicy(o.nonce, o.cspSource)) +
      '" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>' + T('app.title') + '</title>',
    '<link rel="stylesheet" href="' + escapeHtml(o.styleUri) + '" />',
    '<div class="app" dir="' + dir + '" lang="' + escapeHtml(language) + '">',
    '<header class="app__header">',
    '<h1>' + T('app.title') + '</h1>',
    '<p class="app__subtitle">' + T('app.subtitle') + '</p>',
    '<p class="app__status app__status--' +
      escapeHtml(snapshot.health.toLowerCase()) +
      '" role="status" aria-live="polite">' +
      escapeHtml(healthLabel(snapshot.health, language)) +
      '</p>',
    '<p class="app__headline">' + text(snapshot.headline, language) + '</p>',
    '</header>',

    '<main>',
    '<section aria-labelledby="overview-h">',
    '<h2 id="overview-h">' + T('nav.overview') + '</h2>',
    '<dl class="facts">',
    '<dt>' + T('overview.project') + '</dt><dd>' + text(snapshot.projectName, language) + '</dd>',
    '<dt>' +
      T('overview.profile') +
      '</dt><dd>' +
      (snapshot.profileId === undefined
        ? '<span class="empty">' + T('common.none') + '</span>'
        : text(snapshot.profileId, language)) +
      '</dd>',
    '<dt>' + T('overview.nextAction') + '</dt><dd>' + text(snapshot.nextAction, language) + '</dd>',
    '</dl>',
    '</section>',

    '<section aria-labelledby="ask-h">',
    '<h2 id="ask-h">' + T('nav.conversation') + '</h2>',
    ask,
    conversation,
    '</section>',

    '<section aria-labelledby="decisions-h">',
    '<h2 id="decisions-h">' + T('nav.ownerActions') + '</h2>',
    ownerActions,
    '</section>',

    '<section aria-labelledby="stages-h">',
    '<h2 id="stages-h">' + T('coverage.stages') + '</h2>',
    '<ol class="stages">' + stages + '</ol>',
    '</section>',

    '<section aria-labelledby="blockers-h">',
    '<h2 id="blockers-h">' + T('overview.blockers') + '</h2>',
    blockers,
    '</section>',

    '<section aria-labelledby="stale-h">',
    '<h2 id="stale-h">' + T('overview.staleFacts') + '</h2>',
    stale,
    '</section>',

    '<section aria-labelledby="release-h">',
    '<h2 id="release-h">' + T('release.status') + '</h2>',
    release,
    '</section>',

    '<section aria-labelledby="machine-h">',
    '<h2 id="machine-h">' + T('machine.qualification') + '</h2>',
    machine,
    '</section>',
    '</main>',

    '<footer><button type="button" id="refresh">' + T('common.refresh') + '</button></footer>',
    '</div>',
    '<script nonce="' + escapeHtml(o.nonce) + '" src="' + escapeHtml(o.scriptUri) + '"></script>',
  ].join('\n');
}
