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
    rec.continuous = true;
    let latest = '';
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { rec.stop(); } catch (e) {}
      log('capture_result', latest);
      resolve(latest);
    };

    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      latest = text;
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        settled = true;
        reject(new Error('Microphone permission denied (' + e.error + ').'));
        return;
      }
      finish();
    };
    rec.onend = finish;

    try {
      rec.start();
    } catch (err) {
      reject(err);
      return;
    }
    setTimeout(finish, windowSeconds * 1000);
  });
}

async function runExercise(item, windowSeconds, missed) {
  log('exercise_start', { index: item.index, type: item.type, item_id: item.item_id });
  await playClipsSequentially(item.prompt_clips);
  const transcript = await captureSpeech(windowSeconds);
  const result = gradeAttempt(transcript, item.hanzi, item.pinyin);
  log('graded', { index: item.index, correct: result.correct, transcript });
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
