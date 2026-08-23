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

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message === null || typeof message !== 'object') return;
    /* The host re-renders the document on state changes; nothing is patched in here. */
    if (message.kind === 'STATE') vscode.postMessage({ kind: 'REFRESH' });
  });

  vscode.postMessage({ kind: 'READY' });
})();
