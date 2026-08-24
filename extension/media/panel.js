/*
 * THE ONLY SCRIPT IN THE PANEL.
 *
 * It is loaded by nonce, from the extension's own directory, under a CSP that forbids
 * inline script and every remote origin. It does exactly two things: forward a click to
 * the extension host, and paint what the host sends back.
 *
 * It renders NOTHING from project content. The host builds the document; this file never
 * concatenates a string into innerHTML, because the one place that did would be the one
 * place a project's own text could become markup.
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  let counter = 0;

  /*
   * Decision ids are Serva-issued and already narrow, but a selector built by concatenation
   * is the one place a surprising id would change what is selected rather than what is
   * matched. `CSS.escape` where the host provides it, a conservative reject otherwise.
   */
  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/["\\\]]/g, '\\$&');
  }

  function invoke(actionId, input, confirmed) {
    counter += 1;
    vscode.postMessage({
      kind: 'INVOKE',
      requestId: 'r' + String(counter),
      actionId: actionId,
      input: input,
      confirmed: confirmed === true,
    });
  }

  document.addEventListener('click', function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.id === 'refresh') {
      vscode.postMessage({ kind: 'REFRESH' });
      return;
    }

    /*
     * Comparing Serva's records with the repository. A read, so no confirmation — and the
     * host repaints with the result rather than this file patching anything in.
     */
    if (target.hasAttribute('data-reconcile-check')) {
      invoke('reconcile.inspect', {}, true);
      return;
    }

    /*
     * Correcting Serva's OWN records. Unconfirmed from here: the host asks natively, and the
     * service refuses anything that would touch a file the owner might have written — so
     * pressing this cannot revert, stash or clean a working tree even by mistake.
     */
    if (target.hasAttribute('data-reconcile-repair')) {
      invoke('reconcile.repair', {}, false);
      return;
    }

    /*
     * Asking the company for something. The text goes to `conversation.send`, which routes
     * it through classification, planning and Serva's own deterministic check of that plan.
     * There is no action here that hands what the owner typed to a model session, and the
     * allow-list the host enforces does not contain one.
     */
    if (target.hasAttribute('data-ask-submit')) {
      const box = document.querySelector('[data-ask]');
      const error = document.querySelector('[data-ask-error]');
      const asked = box === null ? '' : String(box.value).trim();
      if (asked === '') {
        if (error !== null) error.hidden = false;
        if (box !== null) box.focus();
        return;
      }
      if (error !== null) error.hidden = true;
      invoke('conversation.send', { text: asked }, false);
      return;
    }

    /*
     * A VALUE question. The owner types an answer and presses record; nothing here stands
     * for a value on their behalf, and an empty box is refused in the panel rather than
     * sent as an empty answer — `answerOwnerDecision` would refuse it anyway, but the owner
     * should see why without a round trip.
     */
    const valueFor = target.getAttribute('data-value-submit');
    if (valueFor !== null) {
      const input = document.querySelector('[data-value-for="' + cssEscape(valueFor) + '"]');
      const error = document.querySelector('[data-value-error="' + cssEscape(valueFor) + '"]');
      const typed = input === null ? '' : String(input.value).trim();
      if (typed === '') {
        if (error !== null) error.hidden = false;
        if (input !== null) input.focus();
        return;
      }
      if (error !== null) error.hidden = true;
      /*
       * `confirmed: false`, exactly as for an option. The host shows a native modal that a
       * page cannot fabricate, and only then does the action layer accept the answer.
       */
      invoke('owner.answer', { decisionId: valueFor, value: typed, answeredBy: 'owner' }, false);
      return;
    }

    const decisionId = target.getAttribute('data-option-for');
    if (decisionId !== null) {
      /*
       * `confirmed: false`. The host shows a native modal that a page cannot fabricate,
       * and only then does the action layer accept the answer.
       */
      invoke(
        'owner.answer',
        {
          decisionId: decisionId,
          chosenOption: target.getAttribute('data-option') || '',
          answeredBy: 'owner',
        },
        false,
      );
    }
  });

  /*
   * Enter in the value box records it. Somebody who types an answer and presses Enter has
   * finished answering; making them find a button is a keyboard trap in everything but name.
   */
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const id = target.getAttribute('data-value-for');
    if (id === null) return;
    event.preventDefault();
    const submit = document.querySelector('[data-value-submit="' + cssEscape(id) + '"]');
    if (submit !== null) submit.click();
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message === null || typeof message !== 'object') return;
    /* The host re-renders the document on state changes; nothing is patched in here. */
    if (message.kind === 'STATE') vscode.postMessage({ kind: 'REFRESH' });
  });

  vscode.postMessage({ kind: 'READY' });
})();
