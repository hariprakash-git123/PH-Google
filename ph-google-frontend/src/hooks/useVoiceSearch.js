import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice input for the search box, using the browser's own speech
 * recognition (the Web Speech API: Chrome, Edge, Safari).
 *
 * One click starts one recognition; nothing listens until asked, and
 * nothing asks for the microphone again by itself. Whatever happens —
 * words, silence, a refused permission, an error — recognition ends and
 * `listening` goes back to false: `onend` always fires, and a timer stops a
 * session that outlives MAX_LISTEN_MS.
 *
 * The hook decides for itself when the speaker has finished: once words
 * have arrived and no new ones follow for QUIET_MS, it stops the session.
 * Chrome cannot be left to do it — measured with a real microphone (Chrome
 * 154), it often never marks a result final and keeps the session open for
 * about eight seconds after the last word, so the search would start late,
 * or on whatever fragment was there. Stopping makes Chrome hand over its
 * final text at once; when it gives none, the last words heard are used.
 *
 * The timing, for a person rather than a machine:
 *
 *   START_WAIT_MS  time to begin speaking once the microphone is open. If
 *                  the browser gives up on a silent session sooner than
 *                  this, another is started in its place, unnoticed, so
 *                  "No speech was heard" is never said before it has passed.
 *   QUIET_MS       the pause after the last word that means "finished" —
 *                  long enough to breathe or think mid-sentence. Chrome
 *                  closes a phrase after a much shorter pause; when it
 *                  does, listening goes on for the rest of this one and
 *                  whatever follows is added to what was heard.
 *   MAX_LISTEN_MS  the longest one click can listen, whatever happens.
 *
 * The hook only produces text. What is done with it (filling the box,
 * running the search) is the caller's, so voice uses the same search as
 * typing.
 *
 * To watch a session in the console, run in DevTools:
 *   localStorage.setItem('ph-search:voice-debug', '1')
 * Only states, error codes and the recognised text are logged — never audio.
 */

const MAX_LISTEN_MS = 15000;
const START_WAIT_MS = 4000;
const QUIET_MS = 2800;
// A browser whose sessions end the instant they start is not restarted forever.
const MAX_RESTARTS = 6;
const DEBUG_KEY = 'ph-search:voice-debug';

function debug(...details) {
  try {
    if (window.localStorage.getItem(DEBUG_KEY) !== '1') return;
  } catch {
    return;
  }
  // eslint-disable-next-line no-console
  console.info('[VoiceSearch]', ...details);
}

export const VOICE_MESSAGES = {
  unsupported:
    'Voice search is not supported in this browser. Please use a supported browser such as Chrome or Edge.',
  insecure: 'Voice search needs a secure page (HTTPS, or localhost during development).',
  denied:
    'Microphone access was denied. Please allow microphone access in your browser settings and try again.',
  no_microphone: 'No microphone was found. Check that one is connected and try again.',
  no_speech: 'No speech was heard. Tap the microphone and try again.',
  network: 'Voice search could not reach the speech service. Check your connection and try again.',
  failed: 'Voice search did not work this time. Please try again.'
};

// The recognition service's error codes, as the reasons above.
const ERROR_REASONS = {
  'not-allowed': 'denied',
  'service-not-allowed': 'denied',
  'audio-capture': 'no_microphone',
  'no-speech': 'no_speech',
  network: 'network'
};

const LANGUAGE_TAGS = { Tamil: 'ta-IN', Hindi: 'hi-IN' };
const ENGLISH_BY_REGION = { India: 'en-IN', USA: 'en-US', Australia: 'en-AU' };

/**
 * The speech language for the saved Language and Region preferences
 * (Settings). English as spoken in the chosen region; en-US otherwise.
 */
export function voiceLanguage({ language, region } = {}) {
  return LANGUAGE_TAGS[language] || ENGLISH_BY_REGION[region] || 'en-US';
}

function recognitionClass() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * @param {Object} options
 * @param {string} [options.lang]  BCP 47 tag, e.g. "en-US"
 * @param {(text: string) => void} [options.onInterim]  words so far, while speaking
 * @param {(text: string) => void} options.onFinal  the finished text
 * @returns {{supported: boolean, listening: boolean, error: string|null,
 *            start: () => void, stop: () => void, clearError: () => void}}
 *          `error` is one of the VOICE_MESSAGES keys
 */
export function useVoiceSearch({ lang = 'en-US', onInterim, onFinal }) {
  const [listening, setListening] = useState(false);
  // The microphone is open and audio is flowing: now is the time to speak.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const quietRef = useRef(null);
  const sessionRef = useRef(null);
  // The latest callbacks, so a recognition in progress calls the current ones.
  const callbacks = useRef({ onInterim, onFinal });
  useEffect(() => {
    callbacks.current = { onInterim, onFinal };
  });

  const stop = useCallback(() => {
    // Stopped on purpose — a second click, the pause after speech, the time
    // limit: whatever was heard is the answer, and nothing listens again.
    if (sessionRef.current) sessionRef.current.stopped = true;
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      // Already stopped.
    }
  }, []);

  const start = useCallback(() => {
    // A second click while listening means "that's all": stop and search.
    if (recognitionRef.current) {
      stop();
      return;
    }
    setError(null);

    const Recognition = recognitionClass();
    if (!Recognition) {
      setError('unsupported');
      return;
    }
    if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
      setError('insecure');
      return;
    }

    // One click is one listening session. The browser may end its own
    // recognition early while nothing has been said; then another takes its
    // place (see `launch`), and all of them share what follows.
    const session = {
      heard: '',
      failure: null,
      stopped: false,
      readyAt: 0,
      lastWordAt: 0,
      restarts: 0
    };
    sessionRef.current = session;

    const finish = recognition => {
      clearTimeout(timerRef.current);
      clearTimeout(quietRef.current);
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      sessionRef.current = null;
      setListening(false);
      setReady(false);
      debug(
        'finished',
        session.heard
          ? `→ searching for: ${session.heard}`
          : `→ nothing heard (${session.failure || 'no_speech'})`
      );
      // Words win over an error that arrived with them (a late "no-speech").
      // With no words there is nothing to search for: a message, never an
      // empty search.
      if (session.heard) callbacks.current.onFinal(session.heard);
      else setError(session.failure || 'no_speech');
    };

    /**
     * Starts one recognition. Returns false when the browser refuses to.
     * `spoken` is what earlier recognitions of this session already heard;
     * what this one hears is added after it.
     */
    const launch = (spoken = '') => {
      const recognition = new Recognition();
      recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        debug('onstart');
        setListening(true);
      };
      // Chrome opens the microphone up to a second after the click; words
      // spoken before this are lost, so "speak now" waits for it.
      recognition.onaudiostart = () => {
        debug('onaudiostart');
        if (!session.readyAt) session.readyAt = Date.now();
        setReady(true);
      };
      recognition.onresult = event => {
        if (!session.readyAt) session.readyAt = Date.now();
        setReady(true);
        // Everything recognised so far: the settled results and the one
        // still changing, in order. Chrome may never mark the last one final.
        let text = '';
        let allFinal = event.results.length > 0;
        for (let i = 0; i < event.results.length; i += 1) {
          text += event.results[i][0].transcript;
          if (!event.results[i].isFinal) allFinal = false;
        }
        text = text.replace(/\s+/g, ' ').trim();
        // A result with no words in it does not replace words already heard.
        if (!text) return;
        session.heard = spoken ? `${spoken} ${text}` : text;
        session.lastWordAt = Date.now();
        debug(allFinal ? 'final transcript:' : 'interim transcript:', session.heard);
        if (callbacks.current.onInterim) callbacks.current.onInterim(session.heard);

        // Speech has started: from here, a long enough pause means the
        // speaker has finished. Each new word starts the wait again — also
        // after a result the browser calls final, which only means it heard
        // a pause, not that the speaker is done.
        clearTimeout(quietRef.current);
        quietRef.current = setTimeout(() => {
          debug(`no new words for ${QUIET_MS} ms: finished`);
          stop();
        }, QUIET_MS);
      };
      recognition.onerror = event => {
        debug('onerror:', event.error);
        // "aborted" is this page stopping it, not a failure to report.
        if (event.error === 'aborted') return;
        session.failure = ERROR_REASONS[event.error] || 'failed';
      };
      recognition.onend = () => {
        debug('onend');
        // The browser gave up on silence before the speaker has had the
        // time to begin: keep listening with a fresh recognition. Never
        // after a real failure (a refused microphone is not asked again),
        // never once stopped, and never for ever.
        const silent = !session.heard && (!session.failure || session.failure === 'no_speech');
        const waited = Date.now() - (session.readyAt || session.startedAt);
        if (
          silent &&
          !session.stopped &&
          waited < START_WAIT_MS &&
          session.restarts < MAX_RESTARTS &&
          sessionRef.current === session
        ) {
          session.restarts += 1;
          session.failure = null;
          debug(`ended after ${waited} ms of silence: listening again`);
          if (launch()) return;
        }
        // The browser closed the phrase at a pause (it does after well under
        // a second), but the speaker may only be drawing breath: listen on
        // for what is left of the pause that means "finished". The quiet
        // timer, still running from the last word, ends it.
        const clean = !session.failure || session.failure === 'no_speech';
        if (
          session.heard &&
          clean &&
          !session.stopped &&
          Date.now() - session.lastWordAt < QUIET_MS &&
          session.restarts < MAX_RESTARTS &&
          sessionRef.current === session
        ) {
          session.restarts += 1;
          session.failure = null;
          debug('phrase ended at a pause: listening for more');
          if (launch(session.heard)) return;
        }
        finish(recognition);
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
        return true;
      } catch (startError) {
        debug('start() threw:', startError && startError.name);
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        return false;
      }
    };

    debug('start requested', {
      lang,
      api: window.SpeechRecognition ? 'SpeechRecognition' : 'webkitSpeechRecognition',
      secureContext: window.isSecureContext,
      getUserMedia: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    });
    session.startedAt = Date.now();
    if (!launch()) {
      sessionRef.current = null;
      setListening(false);
      setError('failed');
      return;
    }
    // Shown at once ("Starting microphone…"): the permission prompt can sit
    // open before `onstart`.
    setListening(true);
    timerRef.current = setTimeout(stop, MAX_LISTEN_MS);
  }, [lang, stop]);

  // Leaving the page ends the session without reporting anything.
  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      clearTimeout(quietRef.current);
      if (sessionRef.current) sessionRef.current.stopped = true;
      sessionRef.current = null;
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (!recognition) return;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    },
    []
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    supported: Boolean(recognitionClass()),
    listening,
    // Listening, and the microphone is open: "speak now".
    ready: listening && ready,
    error,
    start,
    stop,
    clearError
  };
}
