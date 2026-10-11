import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import SearchBar from './SearchBar';
import { voiceLanguage } from '../../hooks/useVoiceSearch';

vi.mock('../../services/searchApi', () => ({
  searchApi: { getSuggestions: vi.fn(async () => []) }
}));

/**
 * Voice search, with the browser's speech recognition replaced by a
 * stand-in the test drives: no microphone and no speech service is used.
 */
class FakeRecognition {
  static instances = [];

  constructor() {
    this.started = false;
    FakeRecognition.instances.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    if (this.onend) this.onend();
  }

  abort() {
    this.aborted = true;
  }

  /** The service reporting words: [text, isFinal] pairs. */
  hear(...parts) {
    const results = parts.map(([transcript, isFinal]) =>
      Object.assign([{ transcript }], { isFinal })
    );
    this.onresult({ results });
  }
}
const recognition = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}
const renderBar = (props = {}) =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <SearchBar {...props} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
const mic = () => screen.getByRole('button', { name: /search by voice|stop listening/i });
const box = () => screen.getByRole('textbox', { name: 'Search the web' });
const where = () => screen.getByTestId('where').textContent;

/** The pause after the last word that means the speaker has finished. */
const pauseOfSilence = () => act(() => vi.advanceTimersByTime(2800));

beforeEach(() => {
  // Voice search is all about timing: every test runs on a clock it controls.
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  window.SpeechRecognition = FakeRecognition;
  delete window.webkitSpeechRecognition;
  window.isSecureContext = true;
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
});

describe('voice search', () => {
  it('the microphone starts listening and says so', () => {
    renderBar();
    expect(mic()).toHaveAccessibleName('Search by voice');
    expect(mic()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(mic());
    expect(recognition().started).toBe(true);
    expect(recognition()).toMatchObject({ continuous: false, interimResults: true });
    expect(mic()).toHaveAccessibleName('Stop listening');
    expect(mic()).toHaveAttribute('aria-pressed', 'true');
    expect(mic()).toHaveClass('listening');
    // Not "speak now" yet: the browser has not opened the microphone.
    expect(screen.getByRole('status')).toHaveTextContent('Starting microphone…');
    expect(box()).toHaveAttribute('placeholder', 'Starting microphone…');

    act(() => recognition().onaudiostart());
    expect(screen.getByRole('status')).toHaveTextContent('Listening… speak now');
    expect(box()).toHaveAttribute('placeholder', 'Listening…');
  });

  it('the words appear in the box as they are heard, then the normal search runs', () => {
    renderBar();
    fireEvent.click(mic());
    act(() => recognition().hear(['python', false]));
    expect(box()).toHaveValue('python');
    expect(where()).toBe('/'); // not searched yet

    act(() => {
      recognition().hear(['Python tutorial', true]);
      recognition().onend();
    });
    expect(box()).toHaveValue('Python tutorial');
    // The browser calling it final only means it heard a pause: the search
    // waits to be sure the speaker has finished.
    expect(where()).toBe('/');
    expect(mic()).toHaveClass('listening');
    pauseOfSilence();
    // The same address typing "Python tutorial" and pressing Enter gives.
    expect(where()).toBe('/search?q=Python%20tutorial');
    expect(mic()).toHaveAccessibleName('Search by voice');
    expect(mic()).not.toHaveClass('listening');
    expect(screen.queryByText(/listening/i)).toBeNull();
  });

  it('gives the same search as typing the same words', () => {
    const typed = renderBar();
    fireEvent.change(box(), { target: { value: 'best restaurants in Chennai' } });
    fireEvent.submit(box().closest('form'));
    const typedAddress = where();
    typed.unmount();

    renderBar();
    fireEvent.click(mic());
    act(() => {
      recognition().hear(['best restaurants ', true], ['in Chennai', true]);
      recognition().onend();
    });
    pauseOfSilence();
    expect(where()).toBe(typedAddress);
  });

  it('hands the words to the page’s own search handler when it has one', () => {
    const onSearchSubmit = vi.fn();
    renderBar({ onSearchSubmit });
    fireEvent.click(mic());
    act(() => {
      recognition().hear(['openai', true]);
      recognition().onend();
    });
    expect(onSearchSubmit).not.toHaveBeenCalled();
    pauseOfSilence();
    expect(onSearchSubmit).toHaveBeenCalledTimes(1);
    expect(onSearchSubmit).toHaveBeenCalledWith('openai');
  });

  it('works again and again: each click is a new recognition', () => {
    renderBar();
    for (const [words, address] of [
      ['Python', '/search?q=Python'],
      ['JavaScript', '/search?q=JavaScript']
    ]) {
      fireEvent.click(mic());
      act(() => {
        recognition().hear([words, true]);
        recognition().onend();
      });
      pauseOfSilence();
      expect(where()).toBe(address);
      expect(box()).toHaveValue(words);
      expect(mic()).not.toHaveClass('listening');
    }
    // Two clicks, each with the recognition that heard the words and the one
    // that listened out the pause after them.
    expect(FakeRecognition.instances).toHaveLength(4);
  });

  // Real Chrome often never marks a result final, and keeps listening for
  // seconds after the last word. The search must not wait for that.
  it('searches shortly after the words stop arriving, without waiting for a final result', () => {
    vi.useFakeTimers();
    renderBar();
    fireEvent.click(mic());
    act(() => recognition().hear(['Python', false]));
    // A pause to think is not the end: two seconds pass, and a word follows.
    act(() => vi.advanceTimersByTime(2000));
    expect(mic()).toHaveClass('listening');
    // Each new word starts the wait again.
    act(() => recognition().hear(['Python tutorial', false]));
    act(() => vi.advanceTimersByTime(2700));
    expect(where()).toBe('/');
    expect(mic()).toHaveClass('listening');

    act(() => vi.advanceTimersByTime(100));
    expect(where()).toBe('/search?q=Python%20tutorial');
    expect(box()).toHaveValue('Python tutorial');
    expect(mic()).not.toHaveClass('listening');
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('uses the final text when stopping makes the browser hand one over', () => {
    vi.useFakeTimers();
    renderBar();
    fireEvent.click(mic());
    const session = recognition();
    // Stopping, this browser first delivers its final result, then ends.
    session.stop = () => {
      session.hear(['best restaurants in Chennai', true]);
      session.onend();
    };
    act(() => session.hear(['best restaurants in', false]));
    act(() => vi.advanceTimersByTime(2800));
    expect(where()).toBe('/search?q=best%20restaurants%20in%20Chennai');
  });

  describe('time to begin speaking', () => {
    const noAlert = () => expect(screen.queryByRole('alert')).toBeNull();

    it('a silent session the browser ends early is replaced, unnoticed, and still hears the words', () => {
      vi.useFakeTimers();
      renderBar();
      fireEvent.click(mic());
      act(() => recognition().onaudiostart());
      const first = recognition();

      // One second in, the browser gives up on the silence.
      act(() => vi.advanceTimersByTime(1000));
      act(() => {
        first.onerror({ error: 'no-speech' });
        first.onend();
      });
      expect(FakeRecognition.instances).toHaveLength(2);
      expect(recognition().started).toBe(true);
      noAlert();
      expect(mic()).toHaveClass('listening');
      expect(screen.getByRole('status')).toHaveTextContent('Listening… speak now');

      // The speaker begins; it is heard by the recognition now listening.
      act(() => vi.advanceTimersByTime(1500));
      act(() => {
        recognition().hear(['weather in Chennai today', true]);
        recognition().onend();
      });
      pauseOfSilence();
      expect(where()).toBe('/search?q=weather%20in%20Chennai%20today');
    });

    it('"No speech was heard" is said only once that time has passed', () => {
      vi.useFakeTimers();
      renderBar();
      fireEvent.click(mic());
      act(() => recognition().onaudiostart());

      // Ending at 1 s, 2 s and 3 s: each time, listening goes on.
      for (const second of [1, 2, 3]) {
        act(() => vi.advanceTimersByTime(1000));
        act(() => recognition().onend());
        noAlert();
        expect(mic()).toHaveClass('listening');
        expect(FakeRecognition.instances).toHaveLength(second + 1);
      }
      // Ending after four seconds of silence: now it is said.
      act(() => vi.advanceTimersByTime(1000));
      act(() => recognition().onend());
      expect(screen.getByRole('alert')).toHaveTextContent(
        'No speech was heard. Tap the microphone and try again.'
      );
      expect(mic()).not.toHaveClass('listening');
      expect(FakeRecognition.instances).toHaveLength(4);
      // Nothing was searched for: an empty search is never run.
      expect(where()).toBe('/');
    });

    it('the time counts from the microphone opening, not from the click', () => {
      vi.useFakeTimers();
      renderBar();
      fireEvent.click(mic());
      // The permission prompt sits open for three seconds first.
      act(() => vi.advanceTimersByTime(3000));
      act(() => recognition().onaudiostart());
      act(() => vi.advanceTimersByTime(2000));
      act(() => recognition().onend());
      // Five seconds since the click, two since the microphone opened.
      noAlert();
      expect(FakeRecognition.instances).toHaveLength(2);
    });

    it('a browser that ends every session at once is not restarted for ever', () => {
      renderBar();
      fireEvent.click(mic());
      for (let i = 0; i < 20 && !screen.queryByRole('alert'); i += 1) {
        act(() => recognition().onend());
      }
      expect(screen.getByRole('alert')).toHaveTextContent(/No speech was heard/);
      expect(FakeRecognition.instances).toHaveLength(7); // the first and six more
    });

    it('stopping by hand before speaking ends it there', () => {
      renderBar();
      fireEvent.click(mic());
      fireEvent.click(mic());
      expect(FakeRecognition.instances).toHaveLength(1);
      expect(screen.getByRole('alert')).toHaveTextContent(/No speech was heard/);
    });

    it('a result with no words in it is not searched for, and does not erase words', () => {
      renderBar();
      fireEvent.click(mic());
      act(() => recognition().hear(['python', false]));
      act(() => {
        recognition().hear(['   ', true]);
        recognition().onend();
      });
      pauseOfSilence();
      expect(where()).toBe('/search?q=python');
    });
  });

  // Chrome closes a phrase after a pause of well under a second. A person
  // pausing to think has not finished.
  it('a pause mid-sentence does not cut the query short: what follows is joined on', () => {
    renderBar();
    fireEvent.click(mic());
    const first = recognition();
    act(() => {
      first.hear(['best restaurants', true]);
      first.onend(); // the browser heard a pause and closed the phrase
    });
    expect(box()).toHaveValue('best restaurants');
    expect(where()).toBe('/');
    expect(mic()).toHaveClass('listening');
    expect(FakeRecognition.instances).toHaveLength(2);

    // 1.8 seconds later the speaker goes on.
    act(() => vi.advanceTimersByTime(1800));
    act(() => recognition().hear(['in Chennai', false]));
    expect(box()).toHaveValue('best restaurants in Chennai');
    act(() => {
      recognition().hear(['in Chennai', true]);
      recognition().onend();
    });

    // Only a full pause after the last word ends it.
    act(() => vi.advanceTimersByTime(2700));
    expect(where()).toBe('/');
    act(() => vi.advanceTimersByTime(100));
    expect(where()).toBe('/search?q=best%20restaurants%20in%20Chennai');
    expect(mic()).not.toHaveClass('listening');
  });

  it('a failure while listening out the pause does not lose the words already heard', () => {
    renderBar();
    fireEvent.click(mic());
    act(() => {
      recognition().hear(['python tutorial', true]);
      recognition().onend();
    });
    act(() => {
      recognition().onerror({ error: 'network' });
      recognition().onend();
    });
    expect(where()).toBe('/search?q=python%20tutorial');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a second click while listening stops and searches what was heard', () => {
    renderBar();
    fireEvent.click(mic());
    act(() => recognition().hear(['python tut', false]));
    fireEvent.click(mic());
    expect(FakeRecognition.instances).toHaveLength(1); // stopped, not started again
    expect(where()).toBe('/search?q=python%20tut');
    expect(mic()).toHaveAccessibleName('Search by voice');
  });

  it.each([
    ['not-allowed', /Microphone access was denied\. Please allow microphone access/],
    ['service-not-allowed', /Microphone access was denied/],
    ['audio-capture', /No microphone was found/],
    ['network', /could not reach the speech service/],
    ['language-not-supported', /did not work this time/]
  ])('%s: a friendly message, the microphone back to normal, no search', (code, message) => {
    renderBar();
    fireEvent.click(mic());
    act(() => {
      recognition().onerror({ error: code });
      recognition().onend();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(mic()).toHaveAccessibleName('Search by voice');
    expect(mic()).not.toHaveClass('listening');
    expect(where()).toBe('/');
    // And it did not ask again by itself.
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('silence that simply ends, after the time to begin, is reported as no speech', () => {
    vi.useFakeTimers();
    renderBar();
    fireEvent.click(mic());
    act(() => recognition().onaudiostart());
    // Chrome's own silent session lasts about eight seconds.
    act(() => vi.advanceTimersByTime(8000));
    act(() => recognition().onend());
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/No speech was heard/);
    expect(mic()).not.toHaveClass('listening');
  });

  it('never stays stuck listening: a session that does not end is stopped', () => {
    vi.useFakeTimers();
    renderBar();
    fireEvent.click(mic());
    expect(mic()).toHaveClass('listening');
    act(() => vi.advanceTimersByTime(15000));
    expect(mic()).not.toHaveClass('listening');
    expect(screen.getByRole('alert')).toHaveTextContent(/No speech was heard/);
  });

  it('the message goes away by itself', () => {
    vi.useFakeTimers();
    renderBar();
    fireEvent.click(mic());
    act(() => {
      recognition().onerror({ error: 'not-allowed' });
      recognition().onend();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a browser without speech recognition gets a message, not a crash', () => {
    delete window.SpeechRecognition;
    renderBar();
    fireEvent.click(mic());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Voice search is not supported in this browser. Please use a supported browser such as Chrome or Edge.'
    );
    expect(mic()).not.toHaveClass('listening');
  });

  it('uses the prefixed API where that is the one the browser has', () => {
    delete window.SpeechRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    renderBar();
    fireEvent.click(mic());
    expect(recognition().started).toBe(true);
  });

  it('an insecure page is told why, without asking for the microphone', () => {
    window.isSecureContext = false;
    renderBar();
    fireEvent.click(mic());
    expect(screen.getByRole('alert')).toHaveTextContent(/needs a secure page/);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('leaving the page ends the session quietly', () => {
    const view = renderBar();
    fireEvent.click(mic());
    const session = recognition();
    view.unmount();
    expect(session.aborted).toBe(true);
    expect(session.onend).toBeNull();
  });

  it('listens in the language chosen in Settings', () => {
    expect(voiceLanguage({ language: 'English', region: 'India' })).toBe('en-IN');
    expect(voiceLanguage({ language: 'English', region: 'USA' })).toBe('en-US');
    expect(voiceLanguage({ language: 'English', region: 'Global' })).toBe('en-US');
    expect(voiceLanguage({ language: 'Tamil', region: 'India' })).toBe('ta-IN');
    expect(voiceLanguage({ language: 'Hindi', region: 'USA' })).toBe('hi-IN');
    expect(voiceLanguage()).toBe('en-US');

    window.localStorage.setItem('ph-search:preferences', JSON.stringify({ language: 'Tamil' }));
    renderBar();
    fireEvent.click(mic());
    expect(recognition().lang).toBe('ta-IN');
  });
});

describe('typed search is unchanged', () => {
  it('typing and pressing Enter searches', () => {
    renderBar();
    fireEvent.change(box(), { target: { value: 'python tutorial' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(where()).toBe('/search?q=python%20tutorial');
    expect(FakeRecognition.instances).toHaveLength(0);
  });
});
