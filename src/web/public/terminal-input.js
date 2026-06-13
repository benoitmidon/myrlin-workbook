/**
 * terminal-input.js — TerminalPane input concern (mobile touch + mouse selection)
 *
 * Extracted from terminal.js to isolate everything that deals with pointer/touch
 * input on the xterm surface:
 *   - mobile touch-scroll with momentum + long-press selection
 *   - mobile type/scroll mode switching
 *   - the force-selection shim for mouse-tracking PTY apps (Claude Code Ink TUI,
 *     tmux, vim, …)
 *
 * Loaded AFTER terminal.js; augments TerminalPane.prototype via a mixin so the
 * methods keep normal `this` semantics. terminal.js still calls these from
 * mount()/initMobileInputMode()/dispose().
 *
 * See .claude/memory/terminal-input-selection.md for the design rationale,
 * notably why the shim distinguishes a click (forwarded to the PTY) from a
 * drag (forced text selection).
 */
(function () {
  if (typeof window === 'undefined' || !window.TerminalPane) return;

  const TerminalInputMixin = {
    initMobileInputMode() {
      if (!this._isMobile() || !this.term) return;

      this._mobileTypeMode = false;
      this._mobileSelecting = false;

      const container = document.getElementById(this.containerId);
      if (!container) return;
      const textarea = container.querySelector('.xterm-helper-textarea');
      if (!textarea) return;

      this._xtermTextarea = textarea;
      this._xtermScreen = container.querySelector('.xterm-screen');
      this._xtermViewport = container.querySelector('.xterm-viewport');

      // Disable mobile keyboard autocomplete/autocorrect/spellcheck.
      // These use IME composition events that xterm.js mishandles,
      // causing duplicated/garbled text injection.
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('autocapitalize', 'off');
      textarea.setAttribute('spellcheck', 'false');

      // Default to scroll mode: block touch from reaching textarea and screen.
      // textarea: prevents keyboard popup on scroll
      // screen: block xterm.js's internal touch handling that calls preventDefault
      textarea.style.pointerEvents = 'none';
      if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'none';

      // ── Manual touch-scroll with momentum ──────────────────────────
      // Why manual? xterm.js registers touch/wheel handlers on .xterm-viewport
      // and .xterm that call preventDefault(), blocking native browser scroll
      // even when pointer-events: none is set on .xterm-screen (events still
      // bubble from viewport to .xterm where xterm.js intercepts them).
      //
      // This handler intercepts touches at our container level (capture phase)
      // and uses term.scrollLines() — xterm.js's own scroll API — so that
      // internal scroll state (ydisp) stays in sync. Without this, xterm.js
      // doesn't know the user has scrolled up and snaps back to the bottom
      // on every new PTY output line.
      //
      // Long-press (400ms hold) switches to xterm.js selection mode so the
      // user can highlight text without triggering the keyboard.

      // Line height in pixels: used to convert touch pixel deltas to line counts.
      const fontSize = (this.term.options && this.term.options.fontSize) || 13;
      const lineHeightMult = (this.term.options && this.term.options.lineHeight) || 1.2;
      const lineHeightPx = Math.ceil(fontSize * lineHeightMult);

      let startY = 0;          // Touch start Y position
      let lastY = 0;           // Previous touchmove Y
      let lastTime = 0;        // Previous touchmove timestamp
      let velocity = 0;        // Scroll velocity for momentum (px/ms)
      let momentumRaf = null;  // rAF ID for momentum animation
      let isScrolling = false; // Whether we detected a scroll gesture
      let longPressTimer = null;
      let scrollAccum = 0;     // Sub-line pixel accumulator for smooth scrolling
      let lastMomentumTime = 0;
      const LONG_PRESS_MS = 400;
      const MOVE_THRESHOLD = 8;  // px — must move this far to be a scroll
      const FRICTION = 0.92;     // Momentum deceleration (per 16ms equivalent)
      const MIN_VELOCITY = 0.1;  // Stop momentum below this (px/ms)

      /** Cancel any running momentum animation */
      const stopMomentum = () => {
        if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
        velocity = 0;
      };

      // Mouse-tracking apps (full-screen TUIs like Claude Code's Ink) repaint in
      // place and keep NO xterm scrollback, so term.scrollLines() is a no-op. In
      // that mode scrolling must be sent to the PTY as wheel events; xterm
      // translates a wheel event into an SGR mouse-wheel report. We detect the
      // mode via the 'enable-mouse-events' class xterm sets on \e[?1000h etc.
      const xtermEl = container.querySelector('.xterm');
      let wheelAccum = 0;            // Sub-step pixel accumulator for wheel forwarding
      const WHEEL_STEP_PX = 24;      // px of drag per emitted wheel tick

      /**
       * Scroll by a pixel amount.
       * - PTY mouse-tracking active → forward as wheel events to the PTY (the TUI
       *   scrolls its own content; xterm has no scrollback to move).
       * - otherwise → scroll xterm's own scrollback via scrollLines().
       * scrollLines(n): negative = toward top (older content), positive = toward bottom.
       * Finger moving down (px > 0) shows older content (wheel up / scrollLines negative).
       */
      const scrollByPixels = (px) => {
        if (xtermEl && xtermEl.classList.contains('enable-mouse-events') && this._xtermViewport) {
          wheelAccum += px;
          const r = this._xtermViewport.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          while (Math.abs(wheelAccum) >= WHEEL_STEP_PX) {
            const dir = wheelAccum > 0 ? 1 : -1;   // finger down → wheel up (older content)
            this._xtermViewport.dispatchEvent(new WheelEvent('wheel', {
              deltaY: -dir * 120, deltaMode: 0, clientX: cx, clientY: cy,
              bubbles: true, cancelable: true,
            }));
            wheelAccum -= dir * WHEEL_STEP_PX;
          }
          return;
        }
        scrollAccum += px / lineHeightPx;
        const linesToScroll = Math.trunc(scrollAccum);
        if (linesToScroll !== 0) {
          scrollAccum -= linesToScroll;
          this.term.scrollLines(-linesToScroll);
        }
      };

      /** Animate momentum scroll after finger lifts (time-based, works at any Hz) */
      const animateMomentum = (timestamp) => {
        if (lastMomentumTime === 0) lastMomentumTime = timestamp;
        const dt = Math.min(timestamp - lastMomentumTime, 64); // cap at 64ms (tab switches)
        lastMomentumTime = timestamp;
        velocity *= Math.pow(FRICTION, dt / 16); // scale decay to actual frame time
        if (Math.abs(velocity) < MIN_VELOCITY) { stopMomentum(); return; }
        scrollByPixels(velocity * dt);
        momentumRaf = requestAnimationFrame(animateMomentum);
      };

      const onTouchStart = (e) => {
        // In type mode, let xterm.js handle everything
        if (this._mobileTypeMode) return;
        // If currently selecting, let xterm handle
        if (this._mobileSelecting) return;

        // Block xterm.js from seeing this event (it calls preventDefault)
        e.stopPropagation();
        stopMomentum();
        const touch = e.touches[0];
        startY = touch.clientY;
        lastY = touch.clientY;
        lastTime = Date.now();
        velocity = 0;
        isScrolling = false;
        scrollAccum = 0;

        // Start long-press timer for text selection
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (!isScrolling) this._enableMobileSelection();
        }, LONG_PRESS_MS);
      };

      const onTouchMove = (e) => {
        if (this._mobileTypeMode) return;
        // If selecting, let xterm.js handle the selection drag
        if (this._mobileSelecting) return;

        // Block xterm.js from seeing this event
        e.stopPropagation();

        const touch = e.touches[0];
        const deltaY = touch.clientY - lastY;
        const totalDelta = Math.abs(touch.clientY - startY);
        const now = Date.now();
        const dt = now - lastTime;

        // Once movement exceeds threshold, it's a scroll — cancel long-press
        if (!isScrolling && totalDelta > MOVE_THRESHOLD) {
          isScrolling = true;
          if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        }

        if (isScrolling) {
          // Prevent default browser scroll (e.g. pull-to-refresh on Chrome mobile/tablet)
          if (e.cancelable) e.preventDefault();

          // Scroll via xterm.js API so ydisp stays in sync (prevents snap-back on output)
          scrollByPixels(deltaY);
          // Track velocity for momentum (smoothed exponential average)
          if (dt > 0) {
            const instantV = deltaY / dt;
            velocity = velocity * 0.6 + instantV * 0.4;
          }
        }

        lastY = touch.clientY;
        lastTime = now;
      };

      const onTouchEnd = (e) => {
        if (!this._mobileTypeMode && !this._mobileSelecting) e.stopPropagation();
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

        // If we were selecting, revert after a delay for xterm.js to process
        if (this._mobileSelecting) {
          setTimeout(() => this._disableMobileSelection(), 300);
          return;
        }

        if (this._mobileTypeMode) return;

        // Start momentum animation if finger was moving fast enough
        if (isScrolling && Math.abs(velocity) > MIN_VELOCITY) {
          lastMomentumTime = 0;
          momentumRaf = requestAnimationFrame(animateMomentum);
        }
        isScrolling = false;
      };

      // Use CAPTURE phase to intercept before xterm.js gets the events.
      // Non-passive so we can prevent xterm from seeing the events in scroll mode
      // AND prevent browser pull-to-refresh (overscroll) on mobile/tablet.
      container.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
      container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
      container.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
      container.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });

      // Store cleanup function for dispose()
      this._touchScrollCleanup = () => {
        clearTimeout(longPressTimer);
        stopMomentum();
        container.removeEventListener('touchstart', onTouchStart, { capture: true });
        container.removeEventListener('touchmove', onTouchMove, { capture: true });
        container.removeEventListener('touchend', onTouchEnd, { capture: true });
        container.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      };
    },

    /**
     * Temporarily enable xterm.js touch handling for text selection (long-press).
     * Re-enables pointer-events on .xterm-screen so xterm handles selection,
     * but keeps textarea pointer-events disabled to prevent keyboard popup.
     */
    _enableMobileSelection() {
      this._mobileSelecting = true;
      if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'auto';
      // Haptic feedback if available (subtle vibration signals selection mode)
      if (navigator.vibrate) navigator.vibrate(25);
    },

    /**
     * Disable xterm.js touch handling after selection ends.
     * Reverts .xterm-screen to pointer-events: none for scroll passthrough.
     */
    _disableMobileSelection() {
      this._mobileSelecting = false;
      if (this._xtermScreen && !this._mobileTypeMode) {
        this._xtermScreen.style.pointerEvents = 'none';
      }
    },

    /* ═══════════════════════════════════════════════════════════
       FORCE-SELECTION SHIM (click vs. drag aware)
       When the PTY application enables mouse tracking (Claude Code Ink TUI,
       tmux, vim, etc.), xterm.js forwards all mouse events to the PTY instead
       of performing text selection. On real terminal emulators this is fine
       because the user knows to hold Shift (Linux) or Alt (macOS) to force
       selection. In a web-based terminal manager, this UX is confusing --
       users expect normal click+drag to select text.

       Naive approach (the regression this replaces): re-dispatch EVERY left
       mouse event with shiftKey=true so xterm always force-selects. That broke
       interactive TUIs — a plain click on Claude Code's AskUserQuestion choices
       was swallowed as a zero-length selection and never reached the PTY, so
       the menu could not be answered and re-rendered away.

       Fix: defer the decision until we know whether the gesture is a CLICK or a
       DRAG.
         • mousedown  → suppress and remember it (don't commit either way yet)
         • mousemove  → once movement exceeds DRAG_THRESHOLD, it's a drag:
                        replay the original mousedown + this move with
                        shift/alt so xterm enters force-selection mode.
         • mouseup    → if we dragged, finish the forced selection. If we never
                        moved, it was a plain click: replay mousedown+mouseup
                        WITHOUT modifiers so xterm forwards a clean mouse report
                        to the PTY (interactive menus work again).

       The shim only acts while the .xterm element has the 'enable-mouse-events'
       class (set by xterm.js on mouse-tracking escapes like \e[?1000h). With
       tracking off, native xterm selection already works and we stay out.
       ═══════════════════════════════════════════════════════════ */

    /**
     * Install capture-phase mouse interceptors that distinguish click from drag
     * while a mouse-tracking PTY app is active. Clicks pass through to the PTY;
     * drags trigger xterm.js force-selection.
     * @param {HTMLElement} container - The terminal container element
     */
    _initForceSelectionShim(container) {
      const xtermEl = container.querySelector('.xterm');
      const screenEl = container.querySelector('.xterm-screen');
      if (!xtermEl || !screenEl) return;

      // Full mouse lifecycle for selection.
      const EVENTS = ['mousedown', 'mousemove', 'mouseup'];

      // Tag re-dispatched events so our own interceptor ignores them.
      // (isTrusted is read-only, so we set a custom property instead.)
      const SHIM_TAG = '_forceSelectionShim';

      // Pixels of movement before a press is treated as a selection drag.
      const DRAG_THRESHOLD = 4;

      // Per-gesture state. A gesture starts on a left mousedown while mouse
      // tracking is active and ends on the matching mouseup.
      let armed = false;     // mousedown captured, click-vs-drag still undecided
      let dragging = false;  // movement exceeded threshold → forced selection
      let downEvt = null;    // the suppressed mousedown, for later replay
      let startX = 0;
      let startY = 0;

      // Re-dispatch a mouse event on its original target. When force is true we
      // inject BOTH shift and alt so xterm enters force-selection regardless of
      // the client platform it reports (a Mac client tunnelling into a Linux
      // box still shows as MacIntel). When force is false the event is a faithful
      // copy that xterm forwards to the PTY as a normal mouse report.
      const redispatch = (src, force) => {
        const ev = new MouseEvent(src.type, {
          bubbles: src.bubbles,
          cancelable: src.cancelable,
          view: src.view,
          detail: src.detail,
          screenX: src.screenX,
          screenY: src.screenY,
          clientX: src.clientX,
          clientY: src.clientY,
          button: src.button,
          buttons: src.buttons,
          relatedTarget: src.relatedTarget,
          shiftKey: force ? true : src.shiftKey,
          altKey: force ? true : src.altKey,
          ctrlKey: src.ctrlKey,
          metaKey: src.metaKey,
        });
        ev[SHIM_TAG] = true;
        src.target.dispatchEvent(ev);
      };

      const reset = () => { armed = false; dragging = false; downEvt = null; };

      const interceptor = (e) => {
        // Let our own re-dispatched events pass straight through to xterm.
        if (e[SHIM_TAG]) return;

        if (e.type === 'mousedown') {
          // Only arm a gesture when mouse tracking is active and this is a
          // plain left press. Otherwise leave the event to native xterm
          // (Shift/Alt held = user forces selection; Ctrl/Cmd = modifier click;
          // tracking off = normal selection already works).
          if (!xtermEl.classList.contains('enable-mouse-events')) return;
          if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
          if (e.button !== 0) return;

          // Suppress now; we'll replay as a click or a selection on mouseup.
          e.stopImmediatePropagation();
          e.preventDefault();
          armed = true;
          dragging = false;
          downEvt = e;
          startX = e.clientX;
          startY = e.clientY;
          return;
        }

        // mousemove / mouseup are only ours while a gesture is in flight.
        if (!armed) return;

        if (e.type === 'mousemove') {
          e.stopImmediatePropagation();
          e.preventDefault();
          if (!dragging) {
            const moved = Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY);
            if (moved < DRAG_THRESHOLD) return; // still could be a click
            dragging = true;
            // Begin the forced selection at the original press point…
            redispatch(downEvt, true);
          }
          // …and extend it to the current position.
          redispatch(e, true);
          return;
        }

        if (e.type === 'mouseup') {
          e.stopImmediatePropagation();
          e.preventDefault();
          if (dragging) {
            // Complete the forced text selection.
            redispatch(e, true);
          } else {
            // No drag → it was a click. Deliver a clean mousedown+mouseup to
            // the PTY so interactive TUIs (Claude Code AskUserQuestion, etc.)
            // receive the click.
            redispatch(downEvt, false);
            redispatch(e, false);
          }
          reset();
          return;
        }
      };

      // Register on the CONTAINER (parent of .xterm) in capture phase so we run
      // before xterm.js's own handlers regardless of registration order.
      for (const evt of EVENTS) {
        container.addEventListener(evt, interceptor, { capture: true });
      }

      this._forceSelectionCleanup = () => {
        for (const evt of EVENTS) {
          container.removeEventListener(evt, interceptor, { capture: true });
        }
      };
    },

    /**
     * Switch to type mode - keyboard appears, user can type into terminal.
     * Restores pointer-events on both textarea (keyboard input) and screen
     * (xterm.js touch handling for cursor/selection).
     */
    setMobileTypeMode() {
      if (!this._xtermTextarea || !this.term) return;
      this._mobileTypeMode = true;
      this._xtermTextarea.style.pointerEvents = 'auto';
      if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'auto';
      this.term.focus();
      if (this.onMobileModeChange) this.onMobileModeChange('type');
    },

    /**
     * Switch to scroll mode - keyboard hidden, touch scrolls terminal output.
     * Disables pointer-events on textarea (prevents keyboard popup) and screen
     * (lets touches pass through to viewport for native compositor-thread scroll).
     */
    setMobileScrollMode() {
      if (!this._xtermTextarea) return;
      this._mobileTypeMode = false;
      this._xtermTextarea.style.pointerEvents = 'none';
      if (this._xtermScreen) this._xtermScreen.style.pointerEvents = 'none';
      if (this.term) this.term.blur();
      if (this.onMobileModeChange) this.onMobileModeChange('scroll');
    },

    /**
     * Toggle between scroll and type mode
     */
    toggleMobileInputMode() {
      if (this._mobileTypeMode) {
        this.setMobileScrollMode();
      } else {
        this.setMobileTypeMode();
      }
      return this._mobileTypeMode;
    },
  };

  Object.assign(window.TerminalPane.prototype, TerminalInputMixin);
})();
