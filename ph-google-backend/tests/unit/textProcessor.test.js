const {
  processHtml,
  extractText,
  tokenizeText,
  calculateFrequencies,
  STOP_WORDS
} = require('../../utils/textProcessor');

describe('textProcessor', () => {
  const SAMPLE_HTML = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>React JS Tutorial</title>
        <style> body { color: red; } </style>
      </head>
      <body>
        <script> console.log("Ignore me!"); </script>
        <h1>Hello, World! Welcome to React.</h1>
        <p>React is a JavaScript library for building user interfaces.</p>
        <p>Learn React today!</p>
      </body>
    </html>`;

  describe('HTML removal', () => {
    it('strips all tags and returns visible text', () => {
      const text = extractText('<div><p>Hello <b>world</b></p></div>');
      expect(text).toBe('Hello world');
      expect(text).not.toContain('<');
    });

    it('removes script and style contents', () => {
      const text = extractText(SAMPLE_HTML);
      expect(text).not.toMatch(/console\.log/);
      expect(text).not.toMatch(/color:\s*red/);
      expect(text).toContain('Welcome to React');
    });

    it('excludes head-only elements such as <title> from body text', () => {
      const text = extractText(SAMPLE_HTML);
      // The title is indexed separately via metadata, not via body text.
      expect(text).not.toContain('React JS Tutorial');
    });

    it('collapses runs of whitespace', () => {
      expect(extractText('<p>a\n\n   b\t\tc</p>')).toBe('a b c');
    });

    it('returns an empty string for empty or non-string input', () => {
      expect(extractText('')).toBe('');
      expect(extractText(null)).toBe('');
      expect(extractText(undefined)).toBe('');
      expect(extractText(12345)).toBe('');
    });

    it('does not leak markup from a malformed document', () => {
      const text = extractText('<div><p>unclosed <span>tags');
      expect(text).not.toContain('<');
      expect(text).toContain('unclosed');
    });
  });

  describe('tokenization', () => {
    it('splits text into lowercase word tokens', () => {
      expect(tokenizeText('Hello World Search')).toEqual(['hello', 'world', 'search']);
    });

    it('treats punctuation as a separator rather than part of a token', () => {
      expect(tokenizeText('search-engine, ranking!')).toEqual(['search', 'engine', 'ranking']);
    });

    it('keeps digits and alphanumeric tokens', () => {
      expect(tokenizeText('React 18 ES2015')).toEqual(['react', '18', 'es2015']);
    });

    it('drops single-character tokens', () => {
      expect(tokenizeText('a b cd e fgh')).toEqual(['cd', 'fgh']);
    });

    it('drops tokens longer than the maximum length', () => {
      const long = 'x'.repeat(60);
      expect(tokenizeText(`valid ${long}`)).toEqual(['valid']);
    });

    it('returns an empty array for empty or non-string input', () => {
      expect(tokenizeText('')).toEqual([]);
      expect(tokenizeText(null)).toEqual([]);
      expect(tokenizeText({})).toEqual([]);
    });

    it('returns an empty array when the text is only punctuation', () => {
      expect(tokenizeText('!!! ??? ...')).toEqual([]);
    });
  });

  describe('normalization', () => {
    it('is case-insensitive', () => {
      expect(tokenizeText('REACT React react')).toEqual(['react', 'react', 'react']);
    });

    it('normalizes accented and symbolic characters away', () => {
      // Non a-z0-9 characters become separators.
      expect(tokenizeText('café naïve')).toEqual(['caf', 'na', 've']);
    });
  });

  describe('stop words', () => {
    it('removes common stop words', () => {
      expect(tokenizeText('the quick and the dead')).toEqual(['quick', 'dead']);
    });

    it('exposes the stop-word set', () => {
      expect(STOP_WORDS.has('the')).toBe(true);
      expect(STOP_WORDS.has('and')).toBe(true);
      expect(STOP_WORDS.has('react')).toBe(false);
    });

    it('returns an empty array when every word is a stop word', () => {
      expect(tokenizeText('the and of to is')).toEqual([]);
    });
  });

  describe('frequency calculation', () => {
    it('counts each token', () => {
      expect(calculateFrequencies(['a', 'b', 'a', 'c', 'a'])).toEqual({ a: 3, b: 1, c: 1 });
    });

    it('returns an empty object for an empty token list', () => {
      expect(calculateFrequencies([])).toEqual({});
    });

    it('returns an empty object for non-array input', () => {
      expect(calculateFrequencies(null)).toEqual({});
      expect(calculateFrequencies('abc')).toEqual({});
    });

    it('is not confused by tokens that collide with Object prototype keys', () => {
      const freq = calculateFrequencies(['constructor', 'toString', 'constructor']);
      expect(freq.constructor).toBe(2);
      expect(freq.toString).toBe(1);
    });
  });

  describe('full HTML pipeline', () => {
    it('produces frequency-counted tokens from raw HTML', () => {
      const tokens = processHtml(SAMPLE_HTML);
      const freq = calculateFrequencies(tokens);

      expect(freq.react).toBe(3); // h1 + two paragraphs
      expect(freq.javascript).toBe(1);
      // Stop words and script/style content never reach the index.
      expect(freq.the).toBeUndefined();
      expect(freq.console).toBeUndefined();
      expect(freq.red).toBeUndefined();
    });

    it('returns an empty array for empty HTML', () => {
      expect(processHtml('')).toEqual([]);
      expect(processHtml(null)).toEqual([]);
    });
  });
});
