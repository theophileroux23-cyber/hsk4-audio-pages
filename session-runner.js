/*
 * Shared session-playback logic for index.html (the real page) and
 * dry-run.html (a scripted test harness that mocks SpeechRecognition).
 * window.__sessionLog collects one entry per step, in order, so a dry run
 * can be verified from the log rather than just by code inspection --
 * acceptance checks 5 and 6 read this.
 */
window.__sessionLog = [];
function log(kind, detail) {
  window.__sessionLog.push({ kind, detail, t: Date.now() });
}

function clipUrl(basename) {
  return new URL('clips/' + basename, location.href).toString();
}

// window.__playClip is overridable by the dry-run harness (real <audio>
// playback needs a user-driven page; the harness swaps in an instant
// resolve + log entry instead, and asserts against the log).
window.__playClip = function playClip(basename) {
  return new Promise((resolve, reject) => {
    const a = new Audio(clipUrl(basename));
    a.onended = () => { log('clip_played', basename); resolve(); };
    a.onerror = () => reject(new Error('failed to load/play clip ' + basename));
    a.play().catch(reject);
  });
};

async function playClipsSequentially(basenames) {
  for (const b of basenames) {
    await window.__playClip(b);
  }
}

// Live interim-transcript hook, no-op by default (index.html leaves it
// alone -- hands-free by design). quick-test.html overrides this to show
// what the recognizer is hearing in real time, which is far more useful
// for diagnosing "is the mic even picking me up" than waiting for the
// end-of-round verdict.
window.__onInterim = function () {};

let audioCtx = null;
window.__beep = function beep(freqHz, durationMs) {
  log('beep', freqHz);
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return new Promise((resolve) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freqHz;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
    osc.onended = resolve;
  });
};

function captureSpeech(windowSeconds) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      reject(new Error('SpeechRecognition API not available in this browser.'));
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    // continuous:true -- but we no longer trust the engine's own built-in
    // end-of-speech detection to decide when he's done, in either
    // direction. Tried continuous:true + fixed wait first (real-world:
    // ~3-4s of dead air after he finished). Tried continuous:false next,
    // relying on iOS's own auto-endpointing (real-world: near-random
    // transcripts like an unrelated brand name or an unrelated vulgar
    // phrase for three different words -- the signature of very little
    // actual speech reaching the recognizer, i.e. cut off too early).
    // This version keeps the mic open (continuous:true, no auto-endpoint)
    // and uses OUR OWN silence timer instead: reset a short countdown
    // every time a new interim/final result arrives, and only finalize
    // once that countdown elapses with nothing new -- i.e. he's actually
    // stopped, not whenever the engine's internal VAD guesses he has.
    rec.continuous = true;
    const SILENCE_MS = 1200;
    let latest = '';
    let settled = false;
    let silenceTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(silenceTimer);
      try { rec.stop(); } catch (e) {}
      log('capture_result', latest);
      resolve(latest);
    };

    const armSilenceTimer = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, SILENCE_MS);
    };

    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      latest = text;
      window.__onInterim(text);
      armSilenceTimer(); // new speech signal just arrived -- he may still be talking, so extend
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        settled = true;
        reject(new Error('Microphone permission denied (' + e.error + ').'));
        return;
      }
      window.__onInterim('(recognition error: ' + e.error + ')');
      finish();
    };
    rec.onend = finish;

    window.__onInterim('(listening...)');
    try {
      rec.start();
    } catch (err) {
      reject(err);
      return;
    }
    setTimeout(finish, windowSeconds * 1000); // hard backstop, e.g. total silence
  });
}

async function runExercise(item, windowSeconds, missed) {
  log('exercise_start', { index: item.index, type: item.type, item_id: item.item_id });
  await playClipsSequentially(item.prompt_clips);
  const transcript = await captureSpeech(windowSeconds);
  const result = gradeAttempt(transcript, item.hanzi, item.pinyin);
  log('graded', {
    index: item.index, type: item.type, correct: result.correct, transcript,
    hanzi: item.hanzi, pinyin: item.pinyin, meaning_en: item.meaning_en,
  });
  if (result.correct) {
    await window.__beep(880, 150);
  } else {
    await window.__beep(220, 150);
    missed.push(item.index);
  }
  await playClipsSequentially(item.reveal_clips);
  log('reveal_played', { index: item.index });
}

async function runSession(sessionUrl, onStatus) {
  if (onStatus) onStatus('loading...');
  const res = await fetch(sessionUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error('failed to load ' + sessionUrl + ' (' + res.status + ')');
  const session = await res.json();
  log('session_loaded', { date: session.date, itemCount: session.items.length });

  const missed = [];
  for (const item of session.items) {
    if (item.role === 'exercise') {
      if (onStatus) onStatus('listening...');
      await runExercise(item, session.listening_window_seconds, missed);
    } else {
      await playClipsSequentially(item.clips);
    }
  }

  const cmd = `python src/grade.py --date ${session.date} --missed ${missed.join(',')}`;
  log('session_end', { missed, cmd });
  return { session, missed, cmd };
}
