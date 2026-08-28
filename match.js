/*
 * Grading logic for interactive exercises. No LLM, no network call: exact
 * hanzi match, or toneless-pinyin match via pinyin-pro (client side,
 * vendor/pinyin-pro.min.js, loaded before this file).
 *
 * No tone-accuracy scoring: free speech recognition cannot be trusted at
 * that level (see README "Grading, no tone scoring"). A match on toneless
 * pinyin syllables grades correct even if the actual tone spoken was wrong.
 */

// Strips pinyin tone marks via Unicode NFD decomposition + removing
// combining marks. Also self-heals malformed diacritic sequences (verified
// against a real data-quality issue in this deck's source: "一切"'s stored
// pinyin field contains a stray combining macron on top of a precomposed
// dotted-i, which this same normalization resolves to "yiqie" correctly).
function stripToneMarks(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeForCompare(s) {
  return stripToneMarks(s).toLowerCase().replace(/\s+/g, '').trim();
}

// transcript: raw text from SpeechRecognition (hanzi, as returned by zh-CN).
// expectedHanzi: item's stored hanzi (exact match path).
// expectedPinyin: item's stored pinyin (tone-marked, as in vocab.json).
// Returns { correct: bool, transcriptPinyin: string, expectedPinyinStripped: string }
// so callers/tests can see what the comparison actually did, not just the verdict.
function gradeAttempt(transcript, expectedHanzi, expectedPinyin) {
  const t = (transcript || '').trim();
  const exactHanzi = t.length > 0 && t === expectedHanzi;

  const transcriptPinyinRaw = window.pinyinPro.pinyin(t, { toneType: 'none', type: 'string' });
  const transcriptPinyin = normalizeForCompare(transcriptPinyinRaw);
  const expectedPinyinStripped = normalizeForCompare(expectedPinyin);

  const pinyinMatch = transcriptPinyin.length > 0 && transcriptPinyin === expectedPinyinStripped;

  return {
    correct: exactHanzi || pinyinMatch,
    transcriptPinyin,
    expectedPinyinStripped,
    exactHanzi,
    pinyinMatch,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { gradeAttempt, stripToneMarks, normalizeForCompare };
}
