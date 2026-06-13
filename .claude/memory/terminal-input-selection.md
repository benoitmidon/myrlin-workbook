# Terminal input & text selection (web UI)

Concerne le terminal xterm de `src/web/public/`. Toute la gestion **pointeur/tactile**
vit désormais dans **`terminal-input.js`** (extrait de `terminal.js`, qui faisait 1584 l.).

## Architecture
- `terminal.js` = classe `TerminalPane` (xterm + WebSocket + write batching + activity).
- `terminal-input.js` = mixin `Object.assign(TerminalPane.prototype, …)` ajoutant :
  `initMobileInputMode`, `_enableMobileSelection`, `_disableMobileSelection`,
  `_initForceSelectionShim`, `setMobileTypeMode`, `setMobileScrollMode`,
  `toggleMobileInputMode`.
- `index.html` charge `terminal-input.js` **juste après** `terminal.js`, avant `app.js`
  (pas de bundler : scripts globaux, l'ordre compte).

## Force-selection shim (le point sensible)
Quand une appli PTY active le mouse-tracking (TUI Ink de Claude Code, tmux, vim…),
xterm ajoute la classe `enable-mouse-events` et transmet **tous** les clics au PTY au
lieu de sélectionner du texte. Le shim intercepte les events souris en phase capture
pour permettre la sélection au clic-glissé dans un terminal web.

### Gotcha / régression corrigée
La 1re version re-dispatchait **chaque** clic gauche avec `shiftKey=true` → un simple
clic était transformé en sélection vide et **n'atteignait jamais le PTY**. Conséquence :
les menus interactifs (`AskUserQuestion` de Claude Code) ne pouvaient plus être
cliqués et la question « disparaissait » au redraw.

**Fix = distinguer clic vs glissé** (`_initForceSelectionShim`) :
- `mousedown` → suppression + mémorisation (décision différée).
- `mousemove` → au-delà de `DRAG_THRESHOLD` (4px), c'est un glissé : replay du mousedown
  + move avec shift/alt → force-selection xterm.
- `mouseup` → si glissé : termine la sélection ; sinon (clic) : replay mousedown+mouseup
  **sans** modificateur → le PTY reçoit un vrai clic (les menus TUI refonctionnent).

## Mobile
Scroll manuel via `term.scrollLines()` (capture, `passive:false`) pour garder `ydisp`
en phase et éviter le snap-back ; long-press 400ms → mode sélection. À re-tester sur
device après le fix clic/glissé.

## Branches
- `fix/session-resume-collision` = branche **déployée** (service systemd `myrlin`),
  rester alignée sur `origin`.
- `fix/terminal-click-vs-drag-selection` = ce refactor + fix (WIP isolée en 2 commits).
