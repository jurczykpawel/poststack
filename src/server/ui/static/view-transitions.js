/* A native document transition may be skipped while navigating or changing opt-in state.
   Its ready promise then rejects even though the new document loads successfully. */
(function () {
  function observeTransition(event) {
    if (event.viewTransition) event.viewTransition.ready.catch(function () {});
  }
  window.addEventListener("pageswap", observeTransition);
  window.addEventListener("pagereveal", observeTransition);
})();
